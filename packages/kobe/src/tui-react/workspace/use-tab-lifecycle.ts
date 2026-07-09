/**
 * Mount-once tab-lifecycle effects extracted from `TerminalTabs.tsx` (the
 * ~500-line cap): restart-resume verification (issue #22) and the tab
 * auto-naming poll (the tmux naming pass). Both are mount-only, forever-
 * lived effects — everything they read comes through the caller's
 * `stateRef`/`propsRef` latest-render mirrors, and every write goes
 * through the caller's `update` (which refreshes `stateRef`
 * synchronously). See the TerminalTabs file header for why refs.
 */

import { engineEntry } from "@/engine/registry"
import { deriveTitleFromSessionId } from "@/monitor/auto-title"
import type { VendorId } from "@/types/vendor"
import { useEffect, useState } from "react"
import { type EngineTab, type TabsState, setTabAutoTitle, setTabSpawned } from "../../tui/workspace/terminal-tabs-core"

/** Cadence of the tab auto-naming pass (tmux ran its pass on the monitor tick). */
const NAMING_POLL_MS = 5000

export interface TabLifecycleIO {
  readonly stateRef: { readonly current: TabsState }
  readonly propsRef: { readonly current: { readonly vendor: VendorId } }
  readonly update: (next: TabsState) => void
}

/**
 * Restart resume verification (issue #22): rehydrated tabs' `spawned`
 * flags are up to 5s stale and must be re-verified against the real
 * transcripts before anything spawns. Returns the `hydrating` gate —
 * while true, the caller must not mount anything that spawns.
 */
export function useTabHydration(rehydrated: boolean, io: TabLifecycleIO): boolean {
  const [hydrating, setHydrating] = useState(rehydrated)
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once verification pass; reads propsRef/stateRef for freshness.
  useEffect(() => {
    if (!rehydrated) return
    let cancelled = false
    void (async () => {
      try {
        await Promise.all(
          io.stateRef.current.tabs.map(async (tab) => {
            if (tab.kind !== "engine" || !tab.sessionId) return
            let exists = false
            try {
              exists =
                (await engineEntry(tab.vendor ?? io.propsRef.current.vendor).history.readHistory(tab.sessionId))
                  .length > 0
            } catch {
              /* unreadable store → treat as absent (fresh session) */
            }
            if (cancelled) return
            io.update(setTabSpawned(io.stateRef.current, tab.id, exists))
          }),
        )
      } finally {
        if (!cancelled) setHydrating(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return hydrating
}

/** Auto-naming + existence tracking (the tmux naming pass), mount-only. */
export function useTabNaming(io: TabLifecycleIO): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once interval; reads propsRef/stateRef for freshness.
  useEffect(() => {
    let namingBusy = false
    const timer = setInterval(() => {
      if (namingBusy) return
      const candidates = io.stateRef.current.tabs.filter(
        (tab): tab is EngineTab =>
          tab.kind === "engine" && !!tab.sessionId && (!tab.spawned || (!tab.title && !tab.autoTitle)),
      )
      if (candidates.length === 0) return
      namingBusy = true
      void (async () => {
        try {
          for (const tab of candidates) {
            if (!tab.sessionId) continue
            const title = await deriveTitleFromSessionId(tab.vendor ?? io.propsRef.current.vendor, tab.sessionId)
            if (!title) continue
            let next = setTabSpawned(io.stateRef.current, tab.id, true)
            if (!tab.title && !tab.autoTitle) next = setTabAutoTitle(next, tab.id, title)
            io.update(next)
          }
        } finally {
          namingBusy = false
        }
      })()
    }, NAMING_POLL_MS)
    return () => clearInterval(timer)
  }, [])
}
