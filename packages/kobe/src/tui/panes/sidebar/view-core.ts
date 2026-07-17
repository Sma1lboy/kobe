/**
 * Framework-free view logic for the React sidebar (issue #15, G3; the Solid
 * original was removed 2026-07-07). Pure derivations only — no React, no
 * opentui: view-tab cycling, line budgets, the search-input keystroke
 * reducer, empty-state / label i18n-key selection, and small row helpers
 * (theme-core / lookup / message-core precedent).
 */

import { charWidth, displayWidth } from "../../../lib/display-width"
import { truncateEnd, truncateEndCells } from "../../lib/truncate"
import type { SidebarView } from "./groups"
import type { SidebarTone } from "./row-view"

/** Default width of the PureTUI task-list rail. */
export const SIDEBAR_WIDTH = 32

/** Polling interval for the per-main-row git branch refresh. */
export const MAIN_BRANCH_POLL_MS = 2_000

/** The view tab strip, in `[` / `]` cycle order. */
export const VIEW_TABS: ReadonlyArray<{ view: SidebarView }> = [{ view: "active" }, { view: "archived" }]

/** i18n key for a view tab's label — callers translate with their own `t`. */
export function viewTabLabelKey(view: SidebarView): string {
  switch (view) {
    case "active":
      return "tasks.view.workspace"
    case "archived":
      return "tasks.view.archives"
  }
}

/**
 * Cycle the view by `delta` (-1 = `[` / left, +1 = `]` / right). Wraps:
 * `[` from the leftmost lands on the rightmost and vice versa (loop is the
 * confirmed intended behavior). Returns null when `cur` isn't a known tab.
 */
export function cycleViewTarget(cur: SidebarView, delta: -1 | 1): SidebarView | null {
  const idx = VIEW_TABS.findIndex((t) => t.view === cur)
  if (idx < 0) return null
  return VIEW_TABS[(idx + delta + VIEW_TABS.length) % VIEW_TABS.length]?.view ?? null
}

/**
 * Two-line card budgets. Line 1: container pad (4) + accent edge (1) +
 * badge + its gap (2) + scrollbar (1) + right pad (1) = 9 reserved.
 */
export function titleBudgetFor(width: number): number {
  return Math.max(6, width - 9)
}

/**
 * Line 2: the title reserve plus the badge-column indent (2) and a reserve
 * for the right-aligned `+N −M` chip (~6) ≈ 16 reserved.
 */
export function subtitleBudgetFor(width: number): number {
  return Math.max(6, width - 16)
}

/**
 * Fit the active project filter into the PROJECTS header. Besides the
 * translated section label, the row reserves two padding cells, two gaps,
 * and one divider cell. The label itself is measured in terminal cells so a
 * wide CJK glyph cannot paint past the sidebar edge.
 */
export function truncateProjectFilterLabel(label: string, sectionLabel: string, width: number): string {
  const reservedCells = displayWidth(sectionLabel) + 5
  return truncateEndCells(label, Math.max(0, width - reservedCells), charWidth)
}

/**
 * PROJECTS scroll-region height: cap derived from terminal cells, clamped
 * to a small rail band, then shrunk to the actual content (each project
 * card is 2 lines) so a one-project workspace doesn't reserve dead space.
 */
export function projectScrollMaxHeightFor(terminalHeight: number, projectRowCount: number): number {
  const cellCap = Math.max(2, Math.min(10, Math.floor(terminalHeight * 0.25)))
  const contentHeight = Math.max(2, projectRowCount * 2)
  return Math.min(cellCap, contentHeight)
}

/**
 * i18n key for the task list's empty-state / scoped-empty placeholder.
 * `searching` wins (no fuzzy match), then a project-scoped empty, then the
 * plain per-view empty copy.
 */
export function sidebarEmptyStateKey(opts: {
  readonly searching: boolean
  readonly projectFilter: boolean
  readonly view: SidebarView
}): string {
  if (opts.searching) return "tasks.empty.noMatchSearch"
  if (opts.projectFilter) {
    return opts.view === "active" ? "tasks.empty.noActiveProject" : "tasks.empty.noArchivedProject"
  }
  return opts.view === "active" ? "tasks.empty.noActive" : "tasks.empty.noArchived"
}

/** Widest branch label a two-line card renders before tail-truncation. */
export const BRANCH_LABEL_MAX = 16

export function truncateBranchLabel(branch: string, max = BRANCH_LABEL_MAX): string {
  return truncateEnd(branch, max)
}

/** Map a row tone to its theme slot. */
export function toneColor<V>(theme: Record<SidebarTone, V>, tone: SidebarTone): V {
  switch (tone) {
    case "success":
      return theme.success
    case "warning":
      return theme.warning
    case "primary":
      return theme.primary
    case "error":
      return theme.error
    default:
      return theme.textMuted
  }
}

/** The subset of a keypress the search-input reducer reads. */
export type SearchKeystroke = {
  readonly defaultPrevented: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly option?: boolean
  readonly name?: string
  readonly sequence?: string
}

/**
 * `/`-search inline-input reducer: the next query for a keypress, or null
 * when the key doesn't belong to the input (already consumed by a chord,
 * modifier-prefixed, or non-printable — esc/arrows/function keys have
 * multi-byte sequences or names the search-mode bindings already handle).
 * Backspace pops the last char.
 */
export function searchQueryKeystroke(query: string, evt: SearchKeystroke): string | null {
  if (evt.defaultPrevented) return null
  if (evt.ctrl || evt.meta || evt.option) return null
  if (evt.name === "backspace") return query.slice(0, -1)
  const seq = evt.sequence
  if (!seq || seq.length !== 1) return null
  const code = seq.charCodeAt(0)
  if (code < 32 || code === 127) return null
  return query + seq
}
