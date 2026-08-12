/**
 * Everything about a tab going away — extracted from `TerminalTabs.tsx` for
 * the file-size cap, joining `use-tab-dialogs` / `use-tab-handoffs` /
 * `use-tab-lifecycle` as a per-render hook (state freshness comes from being
 * rebuilt each render, plus refs for the mount-only callers).
 *
 * The four exits a tab has, and why they differ:
 *
 *   - `closeActive`   — ctrl+w. Refuses the last tab with a toast.
 *   - `closeById`     — a close named from OUTSIDE the component (the sidebar
 *     tree's menu). Same semantics as ctrl+w minus the toast: the menu omits
 *     the entry when it would be refused.
 *   - `closeExited`   — the tab's process ended. No viewport carve-out is
 *     needed: that process is already gone.
 *   - `handleActiveExit` — the policy layer above `closeExited`, deciding
 *     between resume, close, and recycle-in-place.
 */

import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { noteClosedPtyKey } from "../../tui/workspace/closed-tab-suppress"
import {
  type TabsState,
  type TerminalTab,
  closeActiveTab,
  closeTab,
  recycleTabs,
  tabExitAction,
  tabPtyKey,
  tabPtyKeyFor,
} from "../../tui/workspace/terminal-tabs-core"
import type { VendorId } from "../../types/vendor"
import { releaseSplitLeaves } from "./TerminalSplit"
import { releaseClosedTabPtys } from "./terminal-tabs-close"

export interface TabCloseDeps {
  readonly stateRef: { readonly current: TabsState }
  readonly propsRef: { readonly current: { readonly taskId: string } }
  readonly updateRef: { readonly current: (next: TabsState) => void }
  /** The tab the strip is showing — render-scope, so the hook is rebuilt with it. */
  readonly active: TerminalTab
  /** Mint a fresh engine-session id on the active engine tab (recycle path). */
  readonly pinSession: (state: TabsState, vendor: VendorId | undefined) => TabsState
  /** Nudge Terminal to re-acquire under the visible tab's key. */
  readonly bumpResetToken: () => void
  /** One-shot-per-tab dead-on-attach resume marks, owned by the component so
   *  they survive this hook being rebuilt every render. */
  readonly resumeTriedRef: { readonly current: Set<string> }
  /** Surface ctrl+w's refusal to close a task's only tab. */
  readonly notifyCannotCloseLast: (tabId: string) => void
}

export interface TabClose {
  readonly closeActive: () => void
  readonly closeById: (id: string) => void
  readonly closeExited: (id: string) => void
  readonly handleActiveExit: (info?: { deadOnAttach?: boolean }) => void
}

export function useTabClose(deps: TabCloseDeps): TabClose {
  const taskId = (): string => deps.propsRef.current.taskId

  /** Auto-close (issue #16): a tab closes itself when its process exits and
   *  releases its PTY. Reads the FRESH state — exit events can arrive from a
   *  stale render (see `handleActiveExit`). */
  function closeExited(id: string): void {
    const current = deps.stateRef.current
    const closing = current.tabs.find((tab) => tab.id === id)
    const { state: next, closedId } = closeTab(current, id)
    if (closedId) {
      const key = closing ? tabPtyKeyFor(taskId(), closing) : tabPtyKey(taskId(), closedId)
      releaseSplitLeaves(key, closing?.splitTree ?? null)
      getDefaultPtyRegistry().release(key)
      // Keep the orphan backstop from adopting the dying session back
      // before its next poll observes the exit (closed-tab-suppress.ts).
      noteClosedPtyKey(key)
    }
    deps.updateRef.current(next)
  }

  function closeById(id: string): void {
    const current = deps.stateRef.current
    const closing = current.tabs.find((tab) => tab.id === id)
    const { state: next, closedId } = closeTab(current, id)
    // Refused (the task's last tab): leave the state alone. The tree's menu
    // omits the entry in that case, so this is the defensive half.
    if (!closedId) return
    deps.updateRef.current(next)
    releaseClosedTabPtys(taskId(), closing, closedId)
  }

  function closeActive(): void {
    const current = deps.stateRef.current
    const closing = current.tabs.find((tab) => tab.id === current.activeId)
    const { state: next, closedId } = closeActiveTab(current)
    if (!closedId) {
      deps.notifyCannotCloseLast(current.activeId)
      return
    }
    deps.updateRef.current(next)
    releaseClosedTabPtys(taskId(), closing, closedId)
  }

  function handleActiveExit(info?: { deadOnAttach?: boolean }): void {
    const active = deps.active
    // An exit event can be the echo of an intentional ctrl+w: closing kills
    // the PTY, which fires onExit into a STALE render before React swaps the
    // Terminal. If the tab is already gone from the fresh state there is
    // nothing to do — acting on the stale snapshot resurrected the closed tab
    // (the "ctrl+w needs two presses" bug).
    if (!deps.stateRef.current.tabs.some((tab) => tab.id === active.id)) return
    // Policy is pure (`tabExitAction`): a live exit means the tab's SHELL
    // ended (engines run inside it — `shellSpawn`), so the tab closes; a
    // corpse found on reattach (host restart, machine reboot) gets ONE resume
    // — releasing the dead handle makes `engineTabSpawn` type
    // `--resume <sessionId>` on the re-acquire (`spawned && !live`).
    const action = tabExitAction(active, info?.deadOnAttach === true, deps.resumeTriedRef.current.has(active.id))
    if (action === "resume") {
      deps.resumeTriedRef.current.add(active.id)
      getDefaultPtyRegistry().release(tabPtyKeyFor(taskId(), active))
      deps.bumpResetToken()
      return
    }
    if (deps.stateRef.current.tabs.length > 1) {
      closeExited(active.id)
      return
    }
    // Last tab: the strip can never be empty — recycle it in place as a fresh
    // engine tab (new session) instead of freezing on the exit banner.
    // `recycleTabs` carries the old tab's title/autoTitle so the recycle does
    // not visibly rename the tab.
    getDefaultPtyRegistry().release(tabPtyKeyFor(taskId(), active))
    deps.resumeTriedRef.current.clear()
    const fresh = deps.pinSession(recycleTabs(active), undefined)
    deps.updateRef.current(fresh)
    if (fresh.activeId === active.id) deps.bumpResetToken()
  }

  return { closeActive, closeById, closeExited, handleActiveExit }
}
