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
import { useEffect, useRef, useState } from "react"
import { TabNamingQueue, type TabNamingTarget } from "../../tui/workspace/tab-naming-queue"
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

/** Immediate auto-naming + existence tracking, with a mount-owned fallback. */
export function useTabNaming(io: TabLifecycleIO): void {
  const ioRef = useRef(io)
  ioRef.current = io
  const queueRef = useRef<TabNamingQueue | null>(null)

  const candidates = (): TabNamingTarget[] =>
    ioRef.current.stateRef.current.tabs
      .filter(
        (tab): tab is EngineTab =>
          tab.kind === "engine" && !!tab.sessionId && (!tab.spawned || (!tab.title && !tab.autoTitle)),
      )
      .map((tab) => ({
        tabId: tab.id,
        sessionId: tab.sessionId as string,
        vendor: tab.vendor ?? ioRef.current.propsRef.current.vendor,
      }))

  const isCurrent = (target: TabNamingTarget): boolean => {
    const tab = ioRef.current.stateRef.current.tabs.find((candidate) => candidate.id === target.tabId)
    return (
      tab?.kind === "engine" && tab.sessionId === target.sessionId && (!tab.spawned || (!tab.title && !tab.autoTitle))
    )
  }

  const applyTitle = (target: TabNamingTarget, title: string): void => {
    const current = ioRef.current.stateRef.current
    const tab = current.tabs.find((candidate) => candidate.id === target.tabId)
    if (tab?.kind !== "engine" || tab.sessionId !== target.sessionId) return
    let next = setTabSpawned(current, tab.id, true)
    if (!tab.title && !tab.autoTitle) next = setTabAutoTitle(next, tab.id, title)
    ioRef.current.update(next)
  }

  const needsImmediateTitle = (target: TabNamingTarget): boolean =>
    engineEntry(target.vendor).terminalTitle?.sessionIdFromTitle !== undefined

  const queue = (): TabNamingQueue => {
    if (queueRef.current) return queueRef.current
    queueRef.current = new TabNamingQueue({
      readTitle: (target) => deriveTitleFromSessionId(target.vendor, target.sessionId),
      isCurrent,
      applyTitle,
    })
    return queueRef.current
  }

  // Immediate path: a render carrying a newly-discovered session id queues
  // its history read now. Keep this scoped to Codex: other engines retain
  // the existing interval behavior in this Codex-title-focused change.
  useEffect(() => queue().enqueue(candidates().filter(needsImmediateTitle)))

  // Slow safety net for Codex plus the unchanged naming pass for other
  // engines. The direct loop deliberately preserves their previous cadence.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once fallback; callbacks read ioRef for freshness.
  useEffect(() => {
    const namingQueue = queue()
    let namingBusy = false
    const timer = setInterval(() => {
      const current = candidates()
      namingQueue.enqueue(current.filter(needsImmediateTitle))
      const intervalTargets = current.filter((target) => !needsImmediateTitle(target))
      if (namingBusy || intervalTargets.length === 0) return
      namingBusy = true
      void (async () => {
        try {
          for (const target of intervalTargets) {
            if (!isCurrent(target)) continue
            const title = await deriveTitleFromSessionId(target.vendor, target.sessionId)
            if (title) applyTitle(target, title)
          }
        } finally {
          namingBusy = false
        }
      })()
    }, NAMING_POLL_MS)
    return () => {
      clearInterval(timer)
      namingQueue.stop()
      if (queueRef.current === namingQueue) queueRef.current = null
    }
  }, [])
}
