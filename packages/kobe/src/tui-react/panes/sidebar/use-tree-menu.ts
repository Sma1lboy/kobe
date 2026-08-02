/**
 * Right-click menu state for the tree sidebar — which row was clicked, the
 * entries it offers, and the highlight.
 *
 * Split from `SidebarTree.tsx` for the file-size cap. What the menu OFFERS is
 * the framework-free `tree-menu.ts`; what an entry DOES stays in the component,
 * because the actions are the host callbacks it already holds. This hook is
 * only the state in between — plus the `t()` pass that turns label keys into
 * text, so the menu follows a language switch.
 */

import { useCallback, useState } from "react"
import type { TreeRow } from "../../../tui/panes/sidebar/tree-core"
import { type TreeMenuAction, type TreeMenuContext, treeMenuItems } from "../../../tui/panes/sidebar/tree-menu"
import { useT } from "../../i18n"
import type { ContextMenuEntry } from "../../ui/context-menu"

export interface TreeMenu {
  readonly open: boolean
  readonly entries: readonly ContextMenuEntry[]
  readonly cursor: number
  readonly x: number
  readonly y: number
  readonly openAt: (row: TreeRow, ctx: TreeMenuContext, x: number, y: number) => void
  readonly close: () => void
  readonly moveCursor: (delta: 1 | -1) => void
  /** Fire the highlighted entry (enter). */
  readonly pickCurrent: () => void
  /** Fire an entry by action id (mouse click on a menu row). */
  readonly pick: (action: string) => void
}

interface OpenMenu {
  readonly row: TreeRow
  readonly actions: readonly TreeMenuAction[]
  readonly entries: readonly ContextMenuEntry[]
  readonly x: number
  readonly y: number
}

export function useTreeMenu(onAction: (action: TreeMenuAction, row: TreeRow) => void): TreeMenu {
  const t = useT()
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

  const close = useCallback((): void => setMenu(null), [])

  const moveCursor = useCallback(
    (delta: 1 | -1): void => {
      const count = menu?.entries.length ?? 0
      if (count === 0) return
      // Wraps: a menu is short enough that walking off the end and landing
      // back at the top is faster than clamping.
      setCursor((prev) => (prev + delta + count) % count)
    },
    [menu],
  )

  const fire = useCallback(
    (action: TreeMenuAction | undefined): void => {
      if (!menu || action === undefined) return
      // Close BEFORE dispatching: several actions open a dialog, and a menu
      // still painted underneath a confirm prompt reads as two live surfaces.
      const row = menu.row
      setMenu(null)
      onAction(action, row)
    },
    [menu, onAction],
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
    openAt,
    close,
    moveCursor,
    pickCurrent,
    pick,
  }
}
