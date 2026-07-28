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
}

export function createLiveEngines(opts: LiveEngineOpts = {}): LiveEngineStore {
  const entries = opts.entries ?? (() => getDefaultPtyRegistry().entries())
  const snapshot = opts.snapshot ?? psSnapshot
  const vendors = new Map<string, VendorId>()
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
      for (const [key, pty] of entries()) {
        live.add(key)
        const pid = pty.shellPid ?? null
        if (pid !== null) pids.set(key, pid)
      }
      let changed = false
      // A key whose PTY is gone (or has no walkable child) holds no identity.
      for (const key of [...vendors.keys()]) {
        if (live.has(key) && pids.has(key)) continue
        vendors.delete(key)
        changed = true
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
          const prev = vendors.get(key) ?? null
          if (prev === vendor) continue
          if (vendor) vendors.set(key, vendor)
          else vendors.delete(key)
          changed = true
        }
      }
      if (changed) emit()
    },
    get(key) {
      return vendors.get(key) ?? null
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
