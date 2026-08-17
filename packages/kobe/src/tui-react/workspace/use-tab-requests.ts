/**
 * Consume the cross-component tab REQUESTS aimed at this task — extracted
 * from `TerminalTabs.tsx` (the ~500-line cap), sibling of
 * `use-tab-handoffs.ts`.
 *
 * All five requests (`terminal-tabs-shared.ts`) share one mount-once
 * listener: activation (F7 attention jump), plugin-pane open/close
 * (`tab.open` / `tab.close`), close-from-elsewhere (the sidebar tree menu)
 * and adoption of live-but-unregistered sessions. Consuming them HERE is
 * what claims them — a request still pending after the listener sweep is
 * one nobody owns, and only then may a background writer touch the state
 * (see `closeTaskTab` / `adoptTaskTabs`).
 *
 * Mount-only and forever-lived: everything is read through the caller's
 * latest-render refs, per the TerminalTabs file header.
 */

import { useEffect } from "react"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { closePluginPanes, openPluginPane } from "../../tui/workspace/pane-split"
import { adoptTabs } from "../../tui/workspace/tabs-adopt"
import {
  type TabsState,
  moveTab,
  selectTab,
  splitLeafPtyKey,
  tabPtyKeyFor,
} from "../../tui/workspace/terminal-tabs-core"
import {
  tabActivationListeners,
  takePaneClose,
  takeTabActivation,
  takeTabAdopt,
  takeTabClose,
  takeTabMove,
  takeTabOpen,
} from "./terminal-tabs-shared"

export interface TabRequestIO {
  readonly stateRef: { readonly current: TabsState }
  readonly propsRef: { readonly current: { readonly taskId: string } }
  /** Latest-render mirror of the caller's single state writer. */
  readonly updateRef: { readonly current: (next: TabsState) => void }
  /** Latest-render mirror of the tab-close handle (`useTabClose`). */
  readonly tabCloseRef: { readonly current: { closeById: (id: string) => void } }
  /** Active leaf geometry for the split-size gate; null when no PTY yet. */
  readonly activeLeafSizeRef: { readonly current: () => { cols: number; rows: number } | null }
}

export function useTabRequests(io: TabRequestIO): void {
  const { stateRef, propsRef, updateRef, tabCloseRef, activeLeafSizeRef } = io
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once by design — every read goes through a latest-render ref.
  useEffect(() => {
    const consume = (): void => {
      const taskId = propsRef.current.taskId
      const tabId = takeTabActivation(taskId)
      if (tabId) {
        const s = stateRef.current
        if (s.activeId !== tabId && s.tabs.some((tab) => tab.id === tabId)) updateRef.current(selectTab(s, tabId))
      }
      // Plugin panes (`tab.open`): split the focused chattab (default) or
      // open a separate command tab — pane-split.ts owns the policy. An
      // explicit tabId hosts the split in THAT tab instead of the focused one.
      const open = takeTabOpen(taskId)
      if (open) {
        const size = activeLeafSizeRef.current()
        updateRef.current(
          openPluginPane(stateRef.current, open.argv, open.title, open.placement, open.direction, size, open.tabId),
        )
      }
      // Pane-close (`tab.close` — the inverse of tab.open): prune matching
      // titled leaves (state first, then release), close whole matching
      // command tabs via the normal close path. tabId scopes the title
      // match to one tab.
      const paneClose = takePaneClose(taskId)
      if (paneClose) {
        const prev = stateRef.current
        const { next, closedLeaves, closedTabIds } = closePluginPanes(prev, paneClose.title, paneClose.tabId)
        if (next !== prev) updateRef.current(next)
        for (const { tabId: id, leafId } of closedLeaves) {
          const tab = prev.tabs.find((x) => x.id === id)
          if (tab) getDefaultPtyRegistry().release(splitLeafPtyKey(tabPtyKeyFor(taskId, tab), leafId))
        }
        for (const id of closedTabIds) tabCloseRef.current.closeById(id)
      }
      // Adoption: a live session this component's state doesn't list becomes
      // a real tab, so it can be opened and closed like any other.
      const adopt = takeTabAdopt(taskId)
      if (adopt) {
        const prev = stateRef.current
        const next = adoptTabs(prev, adopt)
        if (next !== prev) updateRef.current(next)
      }
      // Move-from-elsewhere (sidebar move mode): reorder through the single
      // state writer so the change persists; `moveTab` edge-stops, so a
      // top/bottom press is a same-object no-op nothing writes.
      const move = takeTabMove(taskId)
      if (move) {
        const prev = stateRef.current
        const next = moveTab(prev, move.tabId, move.delta)
        if (next !== prev) updateRef.current(next)
      }
      // Close-from-elsewhere (the sidebar tree's menu): claiming it here is
      // what keeps `closeTaskTab` from ALSO writing the background state —
      // this component owns the state while it is mounted.
      const closeId = takeTabClose(taskId)
      if (closeId) tabCloseRef.current.closeById(closeId)
    }
    consume()
    tabActivationListeners.add(consume)
    return () => {
      tabActivationListeners.delete(consume)
    }
  }, [])
}
