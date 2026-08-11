/**
 * The tree sidebar's right-click menu: which row was clicked, the entries it
 * offers, the highlight, and what each entry does.
 *
 * Split from `SidebarTree.tsx` for the file-size cap. What the menu OFFERS is
 * the framework-free `tree-menu.ts`; this hook is the state in between, plus
 * the `t()` pass that turns label keys into text so the menu follows a language
 * switch, plus the dispatch that routes an entry to the host callback the tree
 * was already holding.
 */

import { useCallback, useState } from "react"
import type { TreeRow } from "../../../tui/panes/sidebar/tree-core"
import { type TreeMenuAction, type TreeMenuContext, treeMenuItems } from "../../../tui/panes/sidebar/tree-menu"
import { useT } from "../../i18n"
import type { ContextMenuEntry } from "../../ui/context-menu"
import type { SidebarTaskCallbacks } from "./types"
import type { TreeState } from "./use-tree-state"

export interface TreeMenu {
  readonly open: boolean
  readonly entries: readonly ContextMenuEntry[]
  readonly cursor: number
  readonly x: number
  readonly y: number
  readonly close: () => void
  readonly moveCursor: (delta: 1 | -1) => void
  /** Fire the highlighted entry (enter). */
  readonly pickCurrent: () => void
  /** Fire an entry by action id (a click on a menu row). */
  readonly pick: (action: string) => void
  /** Right-click landed on a worktree or tab row. */
  readonly openForRow: (flatIndex: number, rowId: string, x: number, y: number) => void
  /** Right-click landed on a project header. */
  readonly openForProject: (projectId: string, x: number, y: number) => void
}

export interface TreeMenuDeps {
  readonly tree: TreeState
  readonly activateRow: (rowId: string) => void
  readonly setCursorIndex: (index: number) => void
  readonly onAddTask?: () => void
  /** Close one tab of a worktree — the host owns the mounted/background split
   *  (`closeTaskTab`), the tree only names the pair. */
  readonly onCloseTab?: (taskId: string, tabId: string) => void
  readonly actions: SidebarTaskCallbacks
}

interface OpenMenu {
  readonly row: TreeRow
  readonly actions: readonly TreeMenuAction[]
  readonly entries: readonly ContextMenuEntry[]
  readonly x: number
  readonly y: number
}

export function useTreeMenu(deps: TreeMenuDeps): TreeMenu {
  const t = useT()
  const { tree, activateRow, setCursorIndex, actions } = deps
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [cursor, setCursor] = useState(0)

  const openAt = useCallback(
    (row: TreeRow, ctx: TreeMenuContext, x: number, y: number): void => {
      const items = treeMenuItems(row, ctx)
      setMenu({
        row,
        actions: items.map((item) => item.action),
        entries: items.map((item) => ({ id: item.action, label: t(item.labelKey), danger: item.danger })),
        x,
        y,
      })
      setCursor(0)
    },
    [t],
  )

  const openForRow = useCallback(
    (flatIndex: number, rowId: string, x: number, y: number): void => {
      const row = tree.rows.find((candidate) => candidate.id === rowId)
      // The "↩ recent" jump row has no menu — it's a shortcut, not a task row.
      if (!row || row.kind === "project" || row.kind === "recent") return
      // Move the cursor too: the menu and the highlight must agree about which
      // row the next action lands on.
      setCursorIndex(flatIndex)
      openAt(row, { tabCount: tree.tabCount(row.task.id) }, x, y)
    },
    [tree.rows, tree.tabCount, openAt, setCursorIndex],
  )

  const openForProject = useCallback(
    (projectId: string, x: number, y: number): void => {
      const row = tree.rows.find((candidate) => candidate.kind === "project" && candidate.id === projectId)
      if (!row) return
      openAt(row, {}, x, y)
    },
    [tree.rows, openAt],
  )

  const close = useCallback((): void => setMenu(null), [])

  const moveCursor = useCallback(
    (delta: 1 | -1): void => {
      const count = menu?.entries.length ?? 0
      if (count === 0) return
      // Wraps: a menu is short enough that walking off the end and landing
      // back at the top beats clamping.
      setCursor((prev) => (prev + delta + count) % count)
    },
    [menu],
  )

  /**
   * Run an entry. Every branch routes to something the tree could already do —
   * the menu adds a route, not a capability (see `tree-menu.ts` for why that
   * rule picks the entries).
   */
  const fire = useCallback(
    (action: TreeMenuAction | undefined): void => {
      if (!menu || action === undefined) return
      // Close BEFORE dispatching: several actions open a dialog, and a menu
      // still painted underneath a confirm prompt reads as two live surfaces.
      const row = menu.row
      setMenu(null)
      if (row.kind === "project") {
        if (action === "newTask") deps.onAddTask?.()
        return
      }
      const taskId = row.task.id
      switch (action) {
        case "open":
          activateRow(row.id)
          break
        case "closeTab":
          // Only a tab row offers it, and only above one tab (tree-menu.ts).
          if (row.kind === "tab") deps.onCloseTab?.(taskId, row.tab.id)
          break
        case "rename":
          actions.onRenameRequest?.(taskId)
          break
        case "pin":
          actions.onPinRequest?.(taskId)
          break
        case "localMerge":
          actions.onLocalMergeRequest?.(taskId)
          break
        case "archive":
          actions.onArchiveRequest?.(taskId)
          break
        case "delete":
          actions.onDeleteRequest?.(taskId)
          break
        default:
          break
      }
    },
    [menu, activateRow, actions, deps.onAddTask, deps.onCloseTab],
  )

  const pickCurrent = useCallback((): void => fire(menu?.actions[cursor]), [fire, menu, cursor])
  const pick = useCallback(
    (action: string): void => fire(menu?.actions.find((candidate) => candidate === action)),
    [fire, menu],
  )

  return {
    open: menu !== null,
    entries: menu?.entries ?? [],
    cursor,
    x: menu?.x ?? 0,
    y: menu?.y ?? 0,
    close,
    moveCursor,
    pickCurrent,
    pick,
    openForRow,
    openForProject,
  }
}
