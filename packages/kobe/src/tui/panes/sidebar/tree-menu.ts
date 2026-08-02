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
 * Project headers are the one place the menu can do something the keyboard
 * cannot, and only because the cursor is structurally unable to rest on them
 * (`treeFlatIds` skips them) — a chord would have nowhere to fire from.
 *
 * Pure: labels are i18n KEYS, not text. The renderer runs them through `t()`
 * so the menu follows a language switch like everything else.
 */

import type { TreeRow } from "./tree-core"

export type TreeMenuAction =
  | "open"
  | "toggle"
  | "focusProject"
  | "newTask"
  | "rename"
  | "pin"
  | "localMerge"
  | "archive"
  | "delete"

export interface TreeMenuItem {
  readonly action: TreeMenuAction
  /** i18n key under `tasks.menu.*`. */
  readonly labelKey: string
  /** Destructive — the renderer paints it in the danger tone. */
  readonly danger?: boolean
}

export interface TreeMenuContext {
  /** The worktree has tabs to disclose (drives Expand/Collapse presence). */
  readonly hasTabs?: boolean
  /** The row's group is currently folded. */
  readonly collapsed?: boolean
  /** Every other project is already folded — the focus toggle reads as undo. */
  readonly projectFocused?: boolean
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
    return [
      { action: "toggle", labelKey: ctx.collapsed ? "tasks.menu.expand" : "tasks.menu.collapse" },
      {
        action: "focusProject",
        labelKey: ctx.projectFocused ? "tasks.menu.showAllProjects" : "tasks.menu.focusProject",
      },
      { action: "newTask", labelKey: "tasks.menu.newTask" },
    ]
  }
  if (row.kind === "worktree") {
    const items: TreeMenuItem[] = [{ action: "open", labelKey: "tasks.menu.open" }]
    // No twisty, no toggle: offering "Expand" on a worktree with nothing to
    // disclose would be a menu entry that visibly does nothing.
    if (ctx.hasTabs === true) {
      items.push({ action: "toggle", labelKey: ctx.collapsed ? "tasks.menu.expand" : "tasks.menu.collapse" })
    }
    items.push(...taskVerbs(row.task.pinned === true))
    return items
  }
  return [{ action: "open", labelKey: "tasks.menu.openTab" }, ...taskVerbs(row.task.pinned === true)]
}
