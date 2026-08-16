/**
 * Multi-source activity arbitration — the herdr model
 * (`refs/herdr/src/terminal/state.rs` `recompute_effective_state`) applied to
 * one tab's activity state.
 *
 * Every status SOURCE writes its own slot; nobody edits anybody else's:
 *
 *   - `hook`     — engine hook events (`report()`). Authoritative while the
 *                  engine lives: hooks see turn boundaries, permission
 *                  prompts, and rate limits that no amount of screen/PTY
 *                  watching can. Idle is never stored — a hook idle CLEARS
 *                  the slot (the tab went quiet on the record).
 *   - `observed` — the activity observer's PTY/foreground facts
 *                  (`observeTab()`). Fills the holes hooks leave by omission
 *                  (ESC interrupt, daemon restart, dead engine) and provides
 *                  the KNOWN-idle marker that distinguishes "we looked, it's
 *                  resting" from "no signal" (the client's `◌` unknown).
 *
 * `recomputeTabActivity` is the ONE place the priority order lives — add a
 * source by adding a slot and a rule here, never by special-casing a writer:
 *
 *   1. a hook entry in a STICKY state (`turn_complete` / `permission_needed`
 *      / `error` / `rate_limited`) always wins — those mean "a human should
 *      look", carry no output by nature, and observation must never dim them.
 *   2. a hook `running` wins UNLESS an observed `rest` fact is fresher than
 *      the claim (herdr's `fallback_not_older_than_hook` — a stale
 *      observation must never idle a fresh turn) AND the claim is at least
 *      `correctHookRunningAfterMs` old (at a turn boundary the PTY evidence
 *      trails the hook by one poll) — then observation corrects it (the
 *      ESC-interrupt / dead-engine gap).
 *   3. any other hook entry wins.
 *   4. no hook entry → the observed slot wins: `running` fills the hole a
 *      daemon restart left (#16), `idle` is the known-idle marker.
 *   5. neither → undefined: unknown, distinguishable from known-idle.
 *
 * Pure: no timers, no bus, no I/O — the registry owns those.
 */

import { type EngineSessionInfo, STICKY_STATES } from "./activity-reduce.ts"
import type { EngineActivityDetail, TaskActivityState } from "./contracts.ts"

/** A hook-claimed state. `state` is never "idle" — hook idle clears the slot. */
export interface HookSlot {
  readonly state: TaskActivityState
  readonly at: number
  readonly detail?: EngineActivityDetail
  readonly vendor?: string
  readonly session?: EngineSessionInfo
}

/** An observer-claimed fact — the PTY/foreground world only knows two. */
export interface ObservedSlot {
  readonly state: "running" | "idle"
  readonly at: number
  readonly vendor?: string
  /** Lineage carried over from the hook slot this observation corrected —
   *  the hook slot is retired once disproved, so the id has to live on
   *  somewhere for late subscribers and the liveness probe. */
  readonly session?: EngineSessionInfo
}

/** One tab's activity record: one slot per source. */
export interface TabActivitySlots {
  hook?: HookSlot
  observed?: ObservedSlot
}

/** The arbitrated result — what subscribers see. */
export interface EffectiveActivity {
  readonly state: TaskActivityState
  readonly at: number
  readonly source: "hook" | "observed"
  readonly detail?: EngineActivityDetail
  readonly vendor?: string
  readonly session?: EngineSessionInfo
}

function fromHook(hook: HookSlot): EffectiveActivity {
  return {
    state: hook.state,
    at: hook.at,
    source: "hook",
    ...(hook.detail ? { detail: hook.detail } : {}),
    ...(hook.vendor ? { vendor: hook.vendor } : {}),
    ...(hook.session ? { session: hook.session } : {}),
  }
}

function fromObserved(observed: ObservedSlot, hook?: HookSlot): EffectiveActivity {
  return {
    state: observed.state,
    at: observed.at,
    source: "observed",
    // Lineage falls back to the hook slot it just corrected: the liveness
    // probe and late subscribers still need to know WHICH engine this was.
    ...((observed.vendor ?? hook?.vendor) ? { vendor: observed.vendor ?? hook?.vendor } : {}),
    ...((observed.session ?? hook?.session) ? { session: observed.session ?? hook?.session } : {}),
  }
}

/**
 * Arbitrate one tab's slots into the effective state subscribers see, or
 * `undefined` when nothing has ever reported (the client's "unknown").
 * `correctHookRunningAfterMs` gates rule 2; `Infinity` (the default) means
 * observation NEVER corrects a hook claim — the observer passes its configured
 * value only when the evidence is positive (resting title / dead session),
 * not on a mere host-unreachable pass.
 */
export function recomputeTabActivity(
  slots: TabActivitySlots,
  now: number,
  correctHookRunningAfterMs: number = Number.POSITIVE_INFINITY,
): EffectiveActivity | undefined {
  const { hook, observed } = slots
  if (hook) {
    if (STICKY_STATES.has(hook.state)) return fromHook(hook)
    if (
      hook.state === "running" &&
      observed?.state === "idle" &&
      observed.at >= hook.at &&
      now - hook.at >= correctHookRunningAfterMs
    ) {
      return fromObserved(observed, hook)
    }
    return fromHook(hook)
  }
  if (observed) return fromObserved(observed)
  return undefined
}
