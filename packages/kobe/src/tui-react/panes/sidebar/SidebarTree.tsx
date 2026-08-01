/** @jsxImportSource @opentui/react */
/**
 * The tree sidebar (owner call 2026-08-01): project → worktree → tab, with
 * the right pane showing nothing but the active session's terminal.
 *
 * Round 2 (same day): the tree keeps the flat sidebar's design language —
 * the same brand header / nav rail / view tabs chrome, the same two-line
 * row cards, the same section-header grammar for project groups. What the
 * tree CHANGES is structure only: tasks group under their project header,
 * a worktree's tabs render as child rows beneath its card, and at most one
 * worktree shows its tabs at a time (expansion follows selection).
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
import { type SidebarView, filterByView } from "../../../tui/panes/sidebar/groups"
import { parseRowId } from "../../../tui/panes/sidebar/tree-core"
import { MAIN_BRANCH_POLL_MS, SIDEBAR_WIDTH, cycleViewTarget } from "../../../tui/panes/sidebar/view-core"
import { bindByIds } from "../../context/keybindings"
import { useOptionalKV } from "../../context/kv"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { useLatest } from "../../lib/use-latest"
import { SidebarBrandHeader, SidebarNavRail, SidebarViewTabs, SidebarZenChip } from "./chrome"
import { SidebarTreeBody } from "./tree-panel"
import type { TreeRowShared } from "./tree-rows"
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
  const [view, setView] = useState<SidebarView>("active")
  const viewTasks = useMemo(() => filterByView(props.tasks, view), [props.tasks, view])

  // The same ~2s branch/changes poll tick the flat sidebar runs — the row
  // cards' `useChanges`/`pollCurrentBranch` effects key on it.
  const [branchTick, setBranchTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setBranchTick((n) => n + 1), MAIN_BRANCH_POLL_MS)
    return () => clearInterval(timer)
  }, [])

  const busyTaskIds = useMemo(() => {
    const busy = new Set<string>()
    for (const [taskId, state] of props.engineState ?? []) {
      if (state.state === "running") busy.add(taskId)
    }
    return busy
  }, [props.engineState])

  const tree = useTreeState({
    tasks: viewTasks,
    kv,
    selectedTaskId: props.selectedId,
    selectedTabId: props.selectedTabId ?? null,
    busyTaskIds,
  })
  const flatIndexOf = useMemo(() => {
    const map = new Map<string, number>()
    tree.flatIds.forEach((id, i) => map.set(id, i))
    return map
  }, [tree.flatIds])

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
        return
      }
      props.onSelectTab?.(taskId, tabId)
      props.onActivate?.(taskId)
    },
    [props.onSelect, props.onActivate, props.onSelectTab],
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
      "sidebar.view": (_evt, slot) => {
        const target = cycleViewTarget(view, (slot ?? 0) % 2 === 0 ? -1 : 1)
        if (target) setView(target)
      },
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

  // Viewport follow — rowEls is keyed by flat index (the row cards' own
  // registration convention), shared by cards and tab rows alike.
  const scrollRef = useRef<ScrollBoxRenderable | null>(null)
  const rowElsRef = useRef<Map<number, BoxRenderable> | null>(null)
  if (rowElsRef.current === null) rowElsRef.current = new Map()
  const rowEls = rowElsRef.current
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll || cursorIndex < 0 || scroll.viewport.height <= 0) return
    const el = rowEls.get(cursorIndex)
    if (el) scroll.scrollChildIntoView(el.id)
  }, [cursorIndex, rowEls])

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

  const shared: TreeRowShared = {
    cursorIndex,
    activeRowId: tree.activeRowId,
    rowEls,
    onPress: (flatIndex, rowId) => {
      setCursorIndex(flatIndex)
      activateRow(rowId)
    },
    branchTick,
    engineState: props.engineState,
    engineLifecycle: props.engineLifecycle,
    taskJobs: props.taskJobs,
    worktreeChanges: props.worktreeChanges,
  }

  return (
    <box
      ref={outerRef}
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
      backgroundColor={theme.backgroundPanel}
      // 1, not 0: the neighbouring panes' top FRAME border eats their row 0,
      // so the borderless rail needs one padding row to align with them.
      paddingTop={1}
      paddingBottom={1}
    >
      <SidebarBrandHeader
        focused={focused}
        status={props.headerStatus ?? null}
        onStatusClick={props.onHeaderStatusClick}
        onAddTask={props.onAddTask}
      />
      <SidebarNavRail nav={props.nav ?? "terminal"} setNav={(next) => props.onNavChange?.(next)} />
      <SidebarViewTabs view={view} setView={setView} />
      <SidebarTreeBody
        rows={tree.rows}
        flatIndexOf={flatIndexOf}
        expandedWorktrees={tree.expandedWorktrees}
        collapsedProjects={tree.collapsedProjects}
        hasTabs={tree.hasTabs}
        view={view}
        shared={shared}
        onToggleProject={tree.toggleProject}
        setScrollRef={(r) => {
          scrollRef.current = r
        }}
      />
      {props.zenActive ? <SidebarZenChip onZenClick={props.onZenClick} /> : null}
      {/* Terminal dimensions are read so the body re-measures on resize. */}
      {dims.height < 0 ? <text>{""}</text> : null}
    </box>
  )
}
