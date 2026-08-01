/** @jsxImportSource @opentui/react */
/**
 * The tree sidebar (owner call 2026-08-01): project → worktree → tab, with
 * the right pane showing nothing but the active session's terminal.
 *
 * A sibling of `Sidebar.tsx` rather than a mode inside it. The two differ in
 * what a ROW is — a two-line task card versus a one-line tree row — and in
 * what the cursor selects (a task versus a task-or-tab), which is most of
 * what that component does. Behind `SIDEBAR_TREE_KEY` so the flat sidebar
 * stays reachable while the tree settles.
 *
 * Navigation is deliberately the same machinery: the cursor indexes one flat
 * id list, so j/k/gg/enter come from the same `createSidebarController` the
 * flat sidebar uses, and a tab row is selectable by exactly the mechanism
 * that already selects tasks.
 */

import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createSidebarController } from "../../../tui/panes/sidebar/controller"
import { buildSidebarRowView } from "../../../tui/panes/sidebar/row-view"
import { type TreeRow, parseRowId } from "../../../tui/panes/sidebar/tree-core"
import { SIDEBAR_WIDTH, toneColor, truncateBranchLabel } from "../../../tui/panes/sidebar/view-core"
import { bindByIds } from "../../context/keybindings"
import { useOptionalKV } from "../../context/kv"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { useLatest } from "../../lib/use-latest"
import { SidebarTreeBody, type TreeGlyph } from "./tree-panel"
import type { TreeRowSharedProps } from "./tree-rows"
import type { SidebarProps } from "./types"
import { useTreeState } from "./use-tree-state"

export type SidebarTreeProps = SidebarProps & {
  /** The selected task's active tab, so the tree can mark the live row. */
  selectedTabId?: string | null
  /** Activate a specific tab of a task (the tree's whole reason to exist). */
  onSelectTab?: (taskId: string, tabId: string) => void
}

export function SidebarTree(props: SidebarTreeProps) {
  const { theme } = useTheme()
  // Optional: the live tab map answers for everything currently running, and
  // the kv snapshot only adds tasks that have not mounted since restart — so
  // a host without the provider renders a correct (if restart-blind) tree.
  const kv = useOptionalKV()
  const focused = props.focused ?? true
  const dims = useTerminalDimensions()

  const busyTaskIds = useMemo(() => {
    const busy = new Set<string>()
    for (const [taskId, state] of props.engineState ?? []) {
      if (state.state === "running") busy.add(taskId)
    }
    return busy
  }, [props.engineState])

  const tree = useTreeState({
    tasks: props.tasks,
    kv,
    selectedTaskId: props.selectedId,
    selectedTabId: props.selectedTabId ?? null,
    busyTaskIds,
  })

  // Cursor: state + ref written together so key handlers between renders read
  // the just-set index (React commits state later — same contract as the flat
  // sidebar's cursor).
  const [cursorIndex, setCursorIndexState] = useState(-1)
  const cursorRef = useRef(cursorIndex)
  const setCursorIndex = useCallback((next: number): void => {
    cursorRef.current = next
    setCursorIndexState(next)
  }, [])
  const flatIdsRef = useLatest(tree.flatIds)
  const cursorId = cursorIndex >= 0 ? (tree.flatIds[cursorIndex] ?? null) : null

  // Follow the active row when the selection moves from elsewhere (the F7
  // attention jump, the inbox). Clamp when the list shrank under the cursor.
  useEffect(() => {
    const ids = tree.flatIds
    const active = tree.activeRowId
    const at = active === null ? -1 : ids.indexOf(active)
    if (at >= 0) {
      if (at !== cursorRef.current) setCursorIndex(at)
      return
    }
    if (cursorRef.current >= ids.length) setCursorIndex(Math.max(0, ids.length - 1))
    else if (cursorRef.current < 0 && ids.length > 0) setCursorIndex(0)
  }, [tree.flatIds, tree.activeRowId, setCursorIndex])

  /**
   * Activate a row: a worktree row switches task, a tab row switches task
   * AND tab. Both go through the host so the right pane, the pty registry,
   * and the tab state all move together.
   */
  const activateRow = useCallback(
    (rowId: string): void => {
      const { taskId, tabId } = parseRowId(rowId)
      props.onSelect(taskId)
      if (tabId === null) {
        props.onActivate?.(taskId)
        // Selecting a worktree reveals its tabs rather than toggling them:
        // the user asked to go there, not to hide what is there.
        tree.revealWorktree(taskId)
        return
      }
      props.onSelectTab?.(taskId, tabId)
      props.onActivate?.(taskId)
    },
    [props.onSelect, props.onActivate, props.onSelectTab, tree.revealWorktree],
  )
  const activateRowRef = useLatest(activateRow)

  const controllerRef = useRef<ReturnType<typeof createSidebarController> | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = createSidebarController({
      getCursor: () => cursorRef.current,
      setCursor: setCursorIndex,
      getFlatIds: () => flatIdsRef.current,
      onSelect: (id) => activateRowRef.current(id),
    })
  }
  const ctrl = controllerRef.current

  // Expand/collapse the row under the cursor. A tab row has nothing to
  // disclose, so the chord walks up to its worktree — pressing it on a child
  // collapsing the parent is the behaviour every file tree has.
  const toggleAtCursor = useCallback((): void => {
    const rowId = flatIdsRef.current[cursorRef.current]
    if (rowId === undefined) return
    tree.toggleWorktree(parseRowId(rowId).taskId)
  }, [tree.toggleWorktree])

  useBindings(() => ({
    enabled: focused,
    bindings: bindByIds({
      "sidebar.nav": (_evt, slot) => {
        if ((slot ?? 0) % 2 === 0) ctrl.moveDown()
        else ctrl.moveUp()
      },
      "sidebar.select": () => ctrl.selectCurrent(),
      "sidebar.goto": (_evt, slot) => {
        if ((slot ?? 0) % 2 === 1) ctrl.pressShiftG()
        else ctrl.pressG()
      },
      "sidebar.tree.toggle": () => toggleAtCursor(),
      "sidebar.delete": () => withCursorTask(props.onDeleteRequest),
      "sidebar.archive": () => withCursorTask(props.onArchiveRequest),
      "sidebar.rename": () => withCursorTask(props.onRenameRequest),
      "sidebar.localMerge": () => withCursorTask(props.onLocalMergeRequest),
      "sidebar.pin": () => withCursorTask(props.onPinRequest),
    }),
  }))

  function withCursorTask(fn?: (taskId: string) => void): void {
    const rowId = flatIdsRef.current[cursorRef.current]
    if (rowId === undefined || !fn) return
    // Per-task verbs target the row's TASK even from a tab row: the verbs
    // (delete/archive/rename) have no tab-level meaning, and refusing them
    // one level down would just make the user press k first.
    fn(parseRowId(rowId).taskId)
  }

  // ctrl+<digit> jump — same contract as the flat sidebar: slot N is the Nth
  // VISIBLE row, so it follows expansion state. Not gated on focus: the chord
  // exists to switch from inside the engine pane.
  useBindings(() => ({
    enabled: true,
    bindings: bindByIds({
      "tasks.jump": (_evt, slot) => {
        const id = flatIdsRef.current[slot ?? 0]
        if (id === undefined) return
        setCursorIndex(slot ?? 0)
        activateRowRef.current(id)
      },
    }),
  }))

  // Viewport follow.
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const rowElsRef = useRef<Map<string, BoxRenderable> | null>(null)
  if (rowElsRef.current === null) rowElsRef.current = new Map()
  const rowEls = rowElsRef.current
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || cursorId === null || scroll.viewport.height <= 0) return
    const el = rowEls.get(cursorId)
    if (el) scroll.scrollChildIntoView(el.id)
  }, [cursorId, rowEls])

  const outerRef = useRef<BoxRenderable | null>(null)
  const effectiveWidth = props.width ?? SIDEBAR_WIDTH
  useEffect(() => {
    const el = outerRef.current
    if (!el) return
    // opentui's width setter force-zeroes flexShrink — restore it here (see
    // the flat Sidebar for the full story).
    el.width = effectiveWidth
    el.flexShrink = 1
    el.minHeight = 0
  }, [effectiveWidth])

  const shared: TreeRowSharedProps = {
    cursorId,
    activeId: tree.activeRowId,
    rowEls,
    onCursorTo: (rowId) => {
      const at = tree.flatIds.indexOf(rowId)
      if (at >= 0) setCursorIndex(at)
    },
    onActivate: (rowId) => activateRow(rowId),
    onToggleExpand: (rowId) => tree.toggleWorktree(parseRowId(rowId).taskId),
  }

  /** A worktree row's state glyph — the same derivation the flat card uses,
   *  so one activity vocabulary covers both sidebars. */
  const glyphFor = useCallback(
    (row: Extract<TreeRow, { kind: "worktree" }>): TreeGlyph => {
      const view = buildSidebarRowView({
        task: row.task,
        activity: props.engineState?.get(row.task.id),
        lifecycle: props.engineLifecycle?.get(row.task.id),
        job: props.taskJobs?.get(row.task.id),
        spinnerFrame: 0,
        subtitleBudget: 0,
        truncateBranch: truncateBranchLabel,
      })
      return { glyph: view.stateGlyph, color: toneColor(theme, view.tone) }
    },
    [props.engineState, props.engineLifecycle, props.taskJobs, theme],
  )

  return (
    <box
      ref={outerRef}
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
      paddingTop={1}
    >
      <SidebarTreeBody
        rows={tree.rows}
        expandedWorktrees={tree.expandedWorktrees}
        collapsedProjects={tree.collapsedProjects}
        hasTabs={tree.hasTabs}
        glyphFor={glyphFor}
        shared={shared}
        setScrollRef={(r) => {
          scrollRef.current = r
        }}
        emptyKey="tasks.empty.active"
      />
      {/* Terminal dimensions are read so the body re-measures on resize. */}
      {dims.height < 0 ? <text>{""}</text> : null}
    </box>
  )
}
