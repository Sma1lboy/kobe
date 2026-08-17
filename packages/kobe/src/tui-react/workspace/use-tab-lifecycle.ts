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
import { deriveTitleFromSession, deriveTitleFromSessionId } from "@/monitor/auto-title"
import type { VendorId } from "@/types/vendor"
import { useEffect, useState } from "react"
import { type EngineTab, type TabsState, setTabAutoTitle, setTabSpawned } from "../../tui/workspace/terminal-tabs-core"

/** Cadence of the tab auto-naming pass (tmux ran its pass on the monitor tick). */
const NAMING_POLL_MS = 5000

export interface TabLifecycleIO {
  readonly stateRef: { readonly current: TabsState }
  readonly propsRef: { readonly current: { readonly vendor: VendorId; readonly worktree: string } }
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

/**
 * True for the ONE engine tab whose conversation is the worktree's origin
 * conversation — the first engine tab in the strip. The naming fallback below
 * is scoped to it, see there.
 */
function isFirstEngineTab(state: TabsState, tabId: string): boolean {
  return state.tabs.find((tab) => tab.kind === "engine")?.id === tabId
}

/**
 * Auto-naming + existence tracking (the tmux naming pass), mount-only.
 *
 * Two ways a tab finds its name, both engine-neutral:
 *
 *  - By SESSION ID, when kobe pinned one at launch. Only claude accepts
 *    `--session-id` (`withClaudeSessionId`), so this is claude's path, and
 *    finding a transcript for that id also proves the tab spawned.
 *  - By WORKTREE, for every other engine — codex/copilot/kimi tabs carry no
 *    pinned id, so before this they never got a first-prompt name at all and
 *    fell all the way to the numbered vendor default ("codex 1"). Their
 *    history readers still resolve a worktree's sessions by the cwd recorded
 *    in the transcript, which is exactly what the daemon's TASK auto-title
 *    already reads, so the tab and the sidebar row agree by construction.
 *
 * The worktree path is scoped to the task's FIRST engine tab on purpose: the
 * worktree's ORIGIN conversation is that tab's by construction, while a later
 * tab's session cannot be told apart from one the user started by hand in the
 * same directory — and a plausible-but-wrong name is worse than the numbered
 * default. It also never sets `spawned`: a transcript in the worktree is not
 * evidence about THIS tab's process, which the session-id path does have.
 */
export function useTabNaming(io: TabLifecycleIO): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once interval; reads propsRef/stateRef for freshness.
  useEffect(() => {
    let namingBusy = false
    const timer = setInterval(() => {
      if (namingBusy) return
      const state = io.stateRef.current
      const unnamed = (tab: EngineTab): boolean => !tab.title && !tab.autoTitle
      const candidates = state.tabs.filter((tab): tab is EngineTab => {
        if (tab.kind !== "engine") return false
        if (tab.sessionId) return !tab.spawned || unnamed(tab)
        return unnamed(tab) && isFirstEngineTab(state, tab.id)
      })
      if (candidates.length === 0) return
      namingBusy = true
      void (async () => {
        try {
          for (const tab of candidates) {
            const vendor = tab.vendor ?? io.propsRef.current.vendor
            const title = tab.sessionId
              ? await deriveTitleFromSessionId(vendor, tab.sessionId)
              : await deriveTitleFromSession(io.propsRef.current.worktree, vendor)
            if (!title) continue
            const current = io.stateRef.current
            let next = current
            if (tab.sessionId) next = setTabSpawned(next, tab.id, true)
            if (!tab.title && !tab.autoTitle) next = setTabAutoTitle(next, tab.id, title)
            if (next !== current) io.update(next)
          }
        } finally {
          namingBusy = false
        }
      })()
    }, NAMING_POLL_MS)
    return () => clearInterval(timer)
  }, [])
}
