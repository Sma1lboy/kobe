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

/**
 * What the CONTENT pane shows. `terminal` is the default — the engine session
 * the sidebar's task list selects — and has no rail row of its own: you are
 * already there, and selecting a task is how you get back.
 */
export type SidebarNav = "terminal" | "kanban" | "automations" | "issues"

export interface SidebarNavItem {
  readonly nav: SidebarNav
  /** i18n key — callers translate with their own `t`. */
  readonly labelKey: string
}

/**
 * The rail, top to bottom. Deliberately does NOT list `terminal`: the task
 * list below IS that destination, so a row for it would be a second control
 * for the same thing — and clicking a task already returns there.
 */
export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = [
  { nav: "kanban", labelKey: "tasks.nav.kanban" },
  { nav: "automations", labelKey: "tasks.nav.automations" },
  { nav: "issues", labelKey: "tasks.nav.issues" },
]

/**
 * Cycle the rail by `delta` (-1 = up, +1 = down), wrapping. Returns null for
 * `terminal`, which is not on the rail — cycling has to start somewhere on it.
 */
export function cycleNavTarget(cur: SidebarNav, delta: -1 | 1): SidebarNav | null {
  const idx = SIDEBAR_NAV_ITEMS.findIndex((item) => item.nav === cur)
  if (idx < 0) return null
  return SIDEBAR_NAV_ITEMS[(idx + delta + SIDEBAR_NAV_ITEMS.length) % SIDEBAR_NAV_ITEMS.length]?.nav ?? null
}
