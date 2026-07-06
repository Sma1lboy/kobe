/**
 * vendor — the SPA's vendor-identity rules, in one place.
 *
 * "Which engine does a task run, what do we call it, and does this workspace
 * mix engines?" used to be split three ways: `engines.ts` owned the label
 * lookup, `task-list.ts` owned the vendor aggregations, and the per-row
 * "label only when mixed" rule was inlined in AppShell — each independently
 * coalescing an unset `task.vendor` to the literal `"claude"`. This module owns
 * all of it, so the unset-vendor default lives in ONE place ({@link
 * DEFAULT_VENDOR}) and the rules are unit-testable without rendering a row.
 *
 * `engines.ts` keeps ONLY its job: fetching the engine-owned list from the
 * bridge (`useEngines` + {@link EngineOption}). This module takes that list as
 * input — it never fetches — so it stays pure and react-free (type-only import
 * of `EngineOption`, no runtime cycle).
 */

import type { EngineOption } from "./engines.ts"
import type { Task } from "./types.ts"

/**
 * The vendor an unset `task.vendor` resolves to. The bridge's engine list and
 * settings already carry the real built-in default; this is the SPA-side
 * fallback so an undefined-vendor task renders identically to an explicit one
 * — and the one line to change if the built-in default ever moves. (CLAUDE.md
 * forbids hard-coding vendor strings in UI logic; the accepted exception is
 * this single named fallback constant, not scattered literals.)
 */
export const DEFAULT_VENDOR = "claude"

/** Resolve a possibly-unset vendor id to a concrete one. */
export function resolveVendor(id: string | undefined): string {
  return id || DEFAULT_VENDOR
}

/** Display label for a vendor id (falls back to the raw id). An unset id
 *  resolves through {@link resolveVendor} just like an explicit default — so an
 *  undefined-vendor task and an explicit default-vendor task render the SAME
 *  label (and respect a user override), matching how {@link distinctTaskVendors}
 *  groups them. */
export function engineLabel(
  list: readonly EngineOption[],
  id: string | undefined,
): string {
  const resolved = resolveVendor(id)
  return list.find((e) => e.id === resolved)?.label ?? resolved
}

/** Distinct engine vendors among the live worktree tasks (unset → the default,
 *  matching {@link engineLabel}; project/archived rows excluded — they aren't
 *  sessions). */
export function distinctTaskVendors(tasks: readonly Task[]): string[] {
  const set = new Set<string>()
  for (const task of tasks) {
    if (task.archived || task.kind === "main") continue
    set.add(resolveVendor(task.vendor))
  }
  return [...set]
}

/** True when the workspace runs more than one engine — only then is a per-task
 *  engine chip worth the visual noise (a single-engine workspace would just
 *  repeat the same label on every row). */
export function isMixedEngineWorkspace(tasks: readonly Task[]): boolean {
  return distinctTaskVendors(tasks).length > 1
}

/** The per-row engine label rule: show a task's engine label ONLY in a
 *  mixed-engine workspace, and never on a project (`main`) row — else every
 *  row repeats the same word. Returns `null` when no chip should render. */
export function perRowEngineLabel(
  list: readonly EngineOption[],
  task: Task,
  mixed: boolean,
): string | null {
  return mixed && task.kind !== "main" ? engineLabel(list, task.vendor) : null
}
