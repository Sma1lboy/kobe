import { truncateEnd } from "../../lib/truncate"
import type { SidebarView } from "./groups"
import type { SidebarTone } from "./row-view"
import type { ChatRunState } from "./types"

export const SIDEBAR_WIDTH = 32

export const MAIN_BRANCH_POLL_MS = 2_000

export const VIEW_TABS: ReadonlyArray<{ view: SidebarView }> = [{ view: "active" }, { view: "archived" }]

export function viewTabLabelKey(view: SidebarView): string {
  switch (view) {
    case "active":
      return "tasks.view.workspace"
    case "archived":
      return "tasks.view.archives"
  }
}

export function cycleViewTarget(cur: SidebarView, delta: -1 | 1): SidebarView | null {
  const idx = VIEW_TABS.findIndex((t) => t.view === cur)
  if (idx < 0) return null
  return VIEW_TABS[(idx + delta + VIEW_TABS.length) % VIEW_TABS.length]?.view ?? null
}

export function titleBudgetFor(width: number): number {
  return Math.max(6, width - 9)
}

export function subtitleBudgetFor(width: number): number {
  return Math.max(6, width - 16)
}

export function projectScrollMaxHeightFor(terminalHeight: number, projectRowCount: number): number {
  const cellCap = Math.max(2, Math.min(10, Math.floor(terminalHeight * 0.25)))
  const contentHeight = Math.max(2, projectRowCount * 2)
  return Math.min(cellCap, contentHeight)
}

export function projectTaskCountKey(count: number): string {
  return count === 1 ? "tasks.project.taskSingular" : "tasks.project.taskPlural"
}

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

export const BRANCH_LABEL_MAX = 16

export function truncateBranchLabel(branch: string, max = BRANCH_LABEL_MAX): string {
  return truncateEnd(branch, max)
}

export function taskIsLive(taskId: string, map: ReadonlyMap<string, ChatRunState> | undefined): boolean {
  if (!map) return false
  const prefix = `${taskId}:`
  for (const [key, state] of map) {
    if (state === "running" && key.startsWith(prefix)) return true
  }
  return false
}

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

export type SearchKeystroke = {
  readonly defaultPrevented: boolean
  readonly ctrl?: boolean
  readonly meta?: boolean
  readonly option?: boolean
  readonly name?: string
  readonly sequence?: string
}

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
