/**
 * Plugin-pane placement (`tab.open` consumption): the DEFAULT is a split of
 * the currently-focused chattab — the pane joins the tab's split group
 * beside the engine (owner semantics 2026-07-29), exactly herdr's
 * `placement = "split"`. `"tab"` opens a separate self-closing command tab
 * instead. Falls back to a tab when the active tab can't host a split
 * (content tab, or the size gate — min-pane cells from the active leaf's
 * rendered size, depth cap when no size is known — made it a no-op).
 */

import { initialSplit, renameLeaf, splitActive } from "./split-core"
import { type TabsState, openCommandTab, setTabSplit } from "./terminal-tabs-core"

export type PanePlacement = "split" | "tab"
export type PaneDirection = "right" | "down"

export function openPluginPane(
  state: TabsState,
  argv: readonly string[],
  title: string,
  placement: PanePlacement = "split",
  direction: PaneDirection = "right",
  /** The active leaf's rendered cells — feeds split-core's size gate. */
  activeSize?: { cols: number; rows: number } | null,
): TabsState {
  if (placement === "tab") return openCommandTab(state, argv, title)
  const active = state.tabs.find((tab) => tab.id === state.activeId)
  if (!active || active.kind === "content") return openCommandTab(state, argv, title)
  // `null` content = the tab's own engine leaf (terminal-tab-split.ts).
  const base = active.splitTree ?? initialSplit<readonly string[] | null>(null)
  const split = splitActive(base, direction === "down" ? "column" : "row", argv, activeSize)
  if (split === base) return openCommandTab(state, argv, title)
  return setTabSplit(state, active.id, renameLeaf(split, split.activeLeafId, title))
}
