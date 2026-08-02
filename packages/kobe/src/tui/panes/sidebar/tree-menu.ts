/**
 * What the tree sidebar's right-click menu offers on a given row.
 *
 * The rule that decides the list: **a row's menu is what that row's KEYBOARD
 * already does.** Nothing here is a new capability — every entry routes to a
 * callback the tree was already wired to, so the menu is a second route for
 * mouse users rather than a second set of rules to keep in sync. That is also
 * why a tab row lists the per-task verbs: the chords behave that way already
 * (`withCursorTask` walks up from a tab to its worktree, because rename /
 * archive / delete have no tab-level meaning).
 *
 * No Expand/Collapse entries anywhere: the tree has no fold (owner call
 * 2026-08-01) — every level always shows everything.
 *
 * Pure: labels are i18n KEYS, not text. The renderer runs them through `t()`
 * so the menu follows a language switch like everything else.
 */

import type { TreeRow } from "./tree-core"

export type TreeMenuAction = "open" | "closeTab" | "newTask" | "rename" | "pin" | "localMerge" | "archive" | "delete"

export interface TreeMenuItem {
  readonly action: TreeMenuAction
  /** i18n key under `tasks.menu.*`. */
  readonly labelKey: string
  /** Destructive — the renderer paints it in the danger tone. */
  readonly danger?: boolean
}

export interface TreeMenuContext {
  /** How many tabs the row's worktree has. Closing is only offered above 1:
   *  `closeTab` refuses to remove a task's last tab, and an entry that does
   *  nothing is worse than no entry. */
  readonly tabCount?: number
}

/** The per-task verbs, shared by worktree and tab rows (see the module note
 *  on why a tab row carries them). */
function taskVerbs(pinned: boolean): TreeMenuItem[] {
  return [
    { action: "rename", labelKey: "tasks.menu.rename" },
    { action: "pin", labelKey: pinned ? "tasks.menu.unpin" : "tasks.menu.pin" },
    { action: "localMerge", labelKey: "tasks.menu.localMerge" },
    { action: "archive", labelKey: "tasks.menu.archive" },
    { action: "delete", labelKey: "tasks.menu.delete", danger: true },
  ]
}

export function treeMenuItems(row: TreeRow, ctx: TreeMenuContext = {}): TreeMenuItem[] {
  if (row.kind === "project") {
    return [{ action: "newTask", labelKey: "tasks.menu.newTask" }]
  }
  if (row.kind === "worktree") {
    return [{ action: "open", labelKey: "tasks.menu.open" }, ...taskVerbs(row.task.pinned === true)]
  }
  const tabItems: TreeMenuItem[] = [{ action: "open", labelKey: "tasks.menu.openTab" }]
  if ((ctx.tabCount ?? 0) > 1) tabItems.push({ action: "closeTab", labelKey: "tasks.menu.closeTab" })
  return [...tabItems, ...taskVerbs(row.task.pinned === true)]
}
