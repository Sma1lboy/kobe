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
  readonly propsRef: { readonly current: { readonly vendor: VendorId; readonly worktree: string } }
  /** tabId → live (status-stripped) OSC title, from `useTurnPolls`. */
  readonly liveTitlesRef: { readonly current: ReadonlyMap<string, string> }
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
    // tabId → the session id the tab's current autoTitle was derived FROM.
    // A codex tab's session can CHANGE under it (the resume picker, a
    // re-run): the engine reports the running session's id in its OSC
    // title (`terminalTitle.sessionIdFromTitle`), so a mismatch re-derives
    // the title from the NEW session instead of wearing the old session's
    // name forever. Per-mount on purpose — a TUI restart just re-derives
    // the same title once.
    const derivedFrom = new Map<string, string>()
    const timer = setInterval(() => {
      if (namingBusy) return
      // A manual rename owns the tab forever — never re-derive those.
      const candidates = io.stateRef.current.tabs.filter((tab): tab is EngineTab => tab.kind === "engine" && !tab.title)
      if (candidates.length === 0) return
      namingBusy = true
      void (async () => {
        try {
          for (const tab of candidates) {
            const vendor = tab.vendor ?? io.propsRef.current.vendor
            const worktree = io.propsRef.current.worktree
            const policy = engineEntry(vendor).terminalTitle
            const liveTitle = io.liveTitlesRef.current.get(tab.id)?.trim() || undefined
            const learned = liveTitle ? policy?.sessionIdFromTitle?.(liveTitle) : undefined
            // An engine whose title stream carries session identity owns the
            // follow-through: a REAL (non-placeholder) live title is a named
            // thread, which already names the tab — nothing to derive.
            if (
              policy?.sessionIdFromTitle &&
              liveTitle &&
              !learned &&
              !policy.isPlaceholderTitle?.(liveTitle, { worktree })
            )
              continue
            // Naming-session resolution order: the launch-time pin (claude);
            // the id the engine reports in its live title (codex — exact,
            // follows session switches); then the newest session the engine
            // recorded for this worktree (bootstrap before the first title
            // arrives, or a bare `codex` whose default title carries no id —
            // the same heuristic `forkSourceSessionId` uses). Engines with no
            // transcript reader (custom) resolve EMPTY_HISTORY → no id →
            // skipped. Heuristic caveat: two UNPINNED tabs in one worktree
            // both resolve the newest session until each reports its own id
            // (F2 corrects).
            let sessionId = tab.sessionId ?? learned ?? null
            if (sessionId && derivedFrom.get(tab.id) === sessionId) continue
            if (!sessionId) {
              sessionId = (await engineEntry(vendor).history.listSessionIdsForWorktree(worktree)).at(-1) ?? null
              if (!sessionId || derivedFrom.get(tab.id) === sessionId) continue
            }
            const title = await deriveTitleFromSessionId(vendor, sessionId)
            if (!title) continue
            let next = setTabSpawned(io.stateRef.current, tab.id, true)
            next = setTabAutoTitle(next, tab.id, title)
            io.update(next)
            derivedFrom.set(tab.id, sessionId)
          }
        } finally {
          namingBusy = false
        }
      })()
    }, NAMING_POLL_MS)
    return () => clearInterval(timer)
  }, [])
}
