/**
 * The sidebar's top-level navigation rail — one row per destination.
 *
 * Deliberately NOT the same axis as {@link SidebarView} (`active` /
 * `archived`). That one filters WHICH TASKS the list shows and stays inside
 * Workspace; this one chooses WHICH SURFACE is open. Folding them into one
 * enum would put "show archived tasks" and "open the automations page" in the
 * same list, which is how you end up with an Archives tab sitting next to a
 * Kanban tab as if they were the same kind of thing.
 *
 * Vertical, one per line (owner call 2026-08-01): the rail is 24 cells wide,
 * so three horizontal chips would truncate the moment a fourth arrives.
 */

/** Where the workspace should be pointed. */
export type SidebarNav = "workspace" | "kanban" | "automations" | "issues"

export interface SidebarNavItem {
  readonly nav: SidebarNav
  /** i18n key — callers translate with their own `t`. */
  readonly labelKey: string
}

/** The rail, top to bottom. Order is the display order. */
export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = [
  { nav: "workspace", labelKey: "tasks.nav.workspace" },
  { nav: "kanban", labelKey: "tasks.nav.kanban" },
  { nav: "automations", labelKey: "tasks.nav.automations" },
  { nav: "issues", labelKey: "tasks.nav.issues" },
]

/**
 * Cycle the rail by `delta` (-1 = up, +1 = down), wrapping — the same loop
 * behaviour the horizontal view tabs had.
 */
export function cycleNavTarget(cur: SidebarNav, delta: -1 | 1): SidebarNav | null {
  const idx = SIDEBAR_NAV_ITEMS.findIndex((item) => item.nav === cur)
  if (idx < 0) return null
  return SIDEBAR_NAV_ITEMS[(idx + delta + SIDEBAR_NAV_ITEMS.length) % SIDEBAR_NAV_ITEMS.length]?.nav ?? null
}

/**
 * Only Workspace keeps the task list (and therefore the Archives toggle)
 * below it — the other destinations are full-page surfaces that replace the
 * whole workspace, so rendering a task list under their rail row would be
 * showing content that is about to be covered.
 */
export function navShowsTaskList(nav: SidebarNav): boolean {
  return nav === "workspace"
}
