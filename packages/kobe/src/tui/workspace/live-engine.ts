/**
 * "Which engine is live in this tab right now" — the framework-free store
 * that replaced title sniffing as kobe's process-identity signal.
 *
 * Before: `vendorFromTerminalTitle` matched the OSC window title by
 * substring, so a claude session whose activity summary happened to
 * mention "codex" relabelled its tab codex and attached a Codex turn
 * detector. A window title is free-form text an engine writes for humans;
 * it was never identity.
 *
 * Now: one `ps` snapshot per tick serves every live PTY — each tab's
 * shell pid roots a process-tree walk (`engine/foreground.ts`). A tab is
 * "running claude" exactly while a claude process is alive under its
 * shell, and stops being so the moment that process exits (owner call
 * 2026-07-27: freeze the identity of what IS running; release it on exit).
 *
 * Self-driving on purpose: it enumerates the PTY registry itself rather
 * than taking a caller-supplied key set, so the two consumers (turn-poll
 * attach, tab-strip titles) share ONE probe instead of racing each other's
 * reconcile.
 */

import { type PsSnapshot, foregroundEngineIn, parsePsSnapshot, psSnapshot } from "../../engine/foreground"
import type { VendorId } from "../../types/vendor"
import type { TaskPtyLike } from "../panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"

/** Live PTYs to probe — injectable so tests drive a fake set. */
export type PtyEntries = () => readonly (readonly [string, TaskPtyLike])[]

export interface LiveEngineStore {
  /** Live vendor for a ptyKey, or null when it runs no engine. */
  get(key: string): VendorId | null
  /**
   * Tri-state identity: a vendor = that engine runs under the key's shell
   * right now; null = an engine RAN here and is gone (the shell sits at its
   * prompt — a ctrl+C'd tab); undefined = the probe can't answer (PTY not
   * attached/spawned yet), so callers fall back to recorded identity.
   * The null/undefined split is what lets an engine tab's creation pin
   * cover the spawn window without also resurrecting a dead engine's name.
   */
  resolve(key: string): VendorId | null | undefined
  /**
   * Auxiliary ptyKey → shell pid pairs to probe ALONGSIDE the local PTY
   * registry (issue #33): the registry only knows PTYs this process
   * attached, but the sidebar tree renders every task's hosted tabs — the
   * pty host's `pty.list` inventory carries their pids, and feeding them
   * here lights a shell-turned-agent row for tasks never opened in this
   * TUI. Hosted sessions only, by construction — the map's source is the
   * host's own inventory, so a foreign terminal can never be probed.
   * A key present in both sources uses the registry's pid.
   */
  setAuxPids(pids: ReadonlyMap<string, number>): void
  /** Subscribe to identity changes (fires when any key's vendor moved). */
  subscribe(listener: () => void): () => void
  /** Run one probe pass now — the interval calls this; tests await it. */
  probe(): Promise<void>
  dispose(): void
}

export type LiveEngineOpts = {
  entries?: PtyEntries
  snapshot?: PsSnapshot
  /** Engines start and stop on human timescales — one `ps` every 2s. */
  intervalMs?: number
  /**
   * Debounce for the OFF edge (issue #33): a lit identity goes dark only
   * after this many CONSECUTIVE engine-free walks. Engines briefly show an
   * empty tree mid-restart (claude relaunching after /login, a wrapper
   *  re-exec), and a 1-probe flicker would strobe the sidebar badge. The ON
   * edge stays immediate — lighting up needs no debounce, the walk only
   * answers a vendor on positive argv evidence.
   */
  releaseAfterMisses?: number
}

export function createLiveEngines(opts: LiveEngineOpts = {}): LiveEngineStore {
  const entries = opts.entries ?? (() => getDefaultPtyRegistry().entries())
  const snapshot = opts.snapshot ?? psSnapshot
  const releaseAfterMisses = Math.max(1, opts.releaseAfterMisses ?? 2)
  const vendors = new Map<string, VendorId>()
  /** Consecutive engine-free walks per lit key — the OFF-edge debounce. */
  const misses = new Map<string, number>()
  /** Keys the last successful probe actually walked — the resolve() tri-state:
   *  in here with no vendor means "shell confirmed engine-free", absent means
   *  "couldn't look" (no PTY / no pid / ps failed). */
  const answered = new Set<string>()
  /** Hosted-session pids the local registry can't see — see setAuxPids. */
  let auxPids: ReadonlyMap<string, number> = new Map()
  const listeners = new Set<() => void>()
  let disposed = false

  const emit = (): void => {
    for (const l of listeners) l()
  }

  const store: LiveEngineStore = {
    async probe() {
      if (disposed) return
      const pids = new Map<string, number>()
      const live = new Set<string>()
      for (const [key, pid] of auxPids) {
        live.add(key)
        pids.set(key, pid)
      }
      for (const [key, pty] of entries()) {
        live.add(key)
        const pid = pty.shellPid ?? null
        // The registry's attached PTY outranks the host inventory's row for
        // the same key — but an attached-yet-unspawned PTY (pid null) must
        // not erase a host pid we can walk.
        if (pid !== null) pids.set(key, pid)
      }
      let changed = false
      // A key whose PTY is gone (or has no walkable child) holds no identity —
      // and no ANSWER either: nothing to walk means "can't look", not "empty".
      for (const key of [...vendors.keys()]) {
        if (live.has(key) && pids.has(key)) continue
        vendors.delete(key)
        misses.delete(key)
        changed = true
      }
      for (const key of [...answered]) {
        if (live.has(key) && pids.has(key)) continue
        answered.delete(key)
      }
      if (pids.size > 0) {
        let rows: ReturnType<typeof parsePsSnapshot>
        try {
          rows = parsePsSnapshot(await snapshot())
        } catch {
          if (changed) emit()
          return // an identity we can't read leaves the last one standing
        }
        if (disposed) return
        for (const [key, pid] of pids) {
          const vendor = foregroundEngineIn(rows, pid)?.vendor ?? null
          answered.add(key)
          const prev = vendors.get(key) ?? null
          if (vendor) {
            misses.delete(key)
            if (prev === vendor) continue
            vendors.set(key, vendor)
            changed = true
            continue
          }
          if (prev === null) continue
          // OFF-edge debounce: hold a lit identity through brief engine-free
          // walks; only consecutive misses confirm the exit.
          const count = (misses.get(key) ?? 0) + 1
          if (count < releaseAfterMisses) {
            misses.set(key, count)
            continue
          }
          misses.delete(key)
          vendors.delete(key)
          changed = true
        }
      }
      if (changed) emit()
    },
    get(key) {
      return vendors.get(key) ?? null
    },
    resolve(key) {
      const vendor = vendors.get(key)
      if (vendor) return vendor
      return answered.has(key) ? null : undefined
    },
    setAuxPids(pids) {
      auxPids = pids
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      disposed = true
      listeners.clear()
      vendors.clear()
      misses.clear()
      answered.clear()
      clearInterval(handle)
    },
  }

  const handle = setInterval(() => {
    void store.probe()
  }, opts.intervalMs ?? 2000)
  handle.unref?.()

  return store
}

/** App-wide store — both consumers read this one so they share a probe. */
let defaultStore: LiveEngineStore | null = null

export function getDefaultLiveEngines(): LiveEngineStore {
  if (!defaultStore) defaultStore = createLiveEngines()
  return defaultStore
}
