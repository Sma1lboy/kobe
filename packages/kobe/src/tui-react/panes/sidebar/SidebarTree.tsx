/** @jsxImportSource @opentui/react */
/**
 * The tree sidebar (owner call 2026-08-01): project → worktree → tab, with
 * the right pane showing nothing but the active session's terminal.
 *
 * Round 2 (same day): the tree keeps the flat sidebar's design language —
 * the same brand header / nav rail / view tabs chrome, the same two-line
 * row cards, the same section-header grammar for project groups. What the
 * tree CHANGES is structure only: tasks group under their project header and
 * a worktree's tabs render as child rows beneath its card. Everything starts
 * expanded (owner call, round 4) — the collapse sets hold only what you folded
 * by hand, so a new worktree or a freshly-mounted tab needs no keystroke.
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
import { type TreeRow, parseRowId } from "../../../tui/panes/sidebar/tree-core"
import type { TreeMenuAction } from "../../../tui/panes/sidebar/tree-menu"
import { MAIN_BRANCH_POLL_MS, SIDEBAR_WIDTH, cycleViewTarget } from "../../../tui/panes/sidebar/view-core"
import { bindByIds } from "../../context/keybindings"
import { useOptionalKV } from "../../context/kv"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { useLatest } from "../../lib/use-latest"
import { ContextMenu } from "../../ui/context-menu"
import { SidebarBrandHeader, SidebarNavRail, SidebarSearchInput, SidebarViewTabs, SidebarZenChip } from "./chrome"
import { SidebarTreeBody } from "./tree-panel"
import type { TreeRowShared } from "./tree-rows"
import type { SidebarProps } from "./types"
import { useTreeMenu } from "./use-tree-menu"
import { useTreeSearch } from "./use-tree-search"
import { useTreeState } from "./use-tree-state"

export type SidebarTreeProps = SidebarProps & {
  /** The selected task's active tab, so the tree can mark the live row. */
  selectedTabId?: string | null
  /** Activate a specific tab of a task (the tree's whole reason to exist). */
  onSelectTab?: (taskId: string, tabId: string) => void
  /** Close one tab of any worktree — offered by the tab row's menu. */
  onCloseTab?: (taskId: string, tabId: string) => void
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

  const search = useTreeSearch({ focused, onActiveChange: props.onSearchActiveChange })
  const tree = useTreeState({
    tasks: viewTasks,
    kv,
    selectedTaskId: props.selectedId,
    selectedTabId: props.selectedTabId ?? null,
    query: search.active ? search.query : "",
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

  // Land the highlight on the top match on every search keystroke. Declared
  // AFTER the follow effect so it wins while a query is open — otherwise the
  // cursor would snap back to the active row you are trying to search away
  // from. (Same ordering contract as the flat sidebar.)
  useEffect(() => {
    void search.query
    if (!search.active) return
    setCursorIndex(0)
  }, [search.active, search.query, setCursorIndex])

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

  /**
   * Move mode reorders PROJECTS in the tree (owner call 2026-08-01), not
   * tasks: the tree already shows a project as a group, so "move" at the
   * level you can see is the group. It routes through the project's `main`
   * task, which `moveTask` already swaps past the neighbouring project's main
   * — no new persistence, no new daemon call (see `mainTaskIdOfProject`).
   */
  const moveMode = props.moveMode === true
  const cursorProjectId = useMemo((): string | null => {
    const rowId = tree.flatIds[cursorIndex]
    if (rowId === undefined) return null
    return tree.projectIdOfTask(parseRowId(rowId).taskId)
  }, [tree.flatIds, tree.projectIdOfTask, cursorIndex])

  const moveCursorProject = useCallback(
    (delta: -1 | 1): void => {
      const rowId = flatIdsRef.current[cursorRef.current]
      if (rowId === undefined) return
      const projectId = tree.projectIdOfTask(parseRowId(rowId).taskId)
      if (projectId === null) return
      // No main checkout ⇒ nothing to move. Silent rather than an error: a
      // repo with only task worktrees has no project row position to change.
      const mainId = tree.mainTaskIdOfProject(projectId)
      if (mainId === null) return
      props.onMoveRequest?.(mainId, delta)
    },
    [tree.projectIdOfTask, tree.mainTaskIdOfProject, props.onMoveRequest],
  )

  const menu = useTreeMenu({
    tree,
    activateRow,
    setCursorIndex,
    onAddTask: props.onAddTask,
    onCloseTab: props.onCloseTab,
    actions: props,
  })

  useBindings(() => ({
    // Search mode swallows the letter chords — j/k/d/a/r must reach the query
    // as text, exactly as in the flat sidebar's keys.ts. An open menu swallows
    // them for the same reason: j/k/enter belong to the menu while it is up.
    enabled: focused && !search.active && !menu.open,
    bindings: bindByIds({
      // In move mode j/k drag the project instead of walking the cursor —
      // same multiplexing the flat sidebar does for tasks.
      "sidebar.nav": (_evt, slot) => {
        const down = (slot ?? 0) % 2 === 0
        if (moveMode) {
          moveCursorProject(down ? 1 : -1)
          return
        }
        if (down) ctrl.moveDown()
        else ctrl.moveUp()
      },
      "sidebar.select": () => {
        if (moveMode) {
          props.onMoveModeExit?.()
          return
        }
        ctrl.selectCurrent()
      },
      "sidebar.goto": (_evt, slot) => {
        if (moveMode) return
        if ((slot ?? 0) % 2 === 1) ctrl.pressShiftG()
        else ctrl.pressG()
      },
      // `l` is "go in", not "unfold" (owner call 2026-08-01: the tree never
      // folds): open the row under the cursor — on a tab row, the last
      // level, that enters the tab's chat.
      "sidebar.tree.open": () => {
        if (moveMode) return
        ctrl.selectCurrent()
      },
      "sidebar.search.enter": () => {
        if (moveMode) return
        search.enter()
      },
      "sidebar.delete": () => {
        if (moveMode) return
        withCursorTask(props.onDeleteRequest)
      },
      "sidebar.archive": () => {
        if (moveMode) return
        withCursorTask(props.onArchiveRequest)
      },
      "sidebar.rename": () => {
        if (moveMode) return
        withCursorTask(props.onRenameRequest)
      },
      "sidebar.localMerge": () => withCursorTask(props.onLocalMergeRequest),
      "sidebar.pin": () => {
        if (moveMode) return
        withCursorTask(props.onPinRequest)
      },
    }),
  }))

  // Escape leaves move mode — the same raw binding keys.ts uses, since escape
  // has no sidebar-scope registry entry outside search.
  useBindings(() => ({
    enabled: focused && moveMode,
    bindings: [{ key: "escape", cmd: () => props.onMoveModeExit?.() }],
  }))

  // View switching stays live during search (flat sidebar's Block B): `[`/`]`
  // are not text, and re-scoping the list mid-query is a reasonable thing to
  // want.
  useBindings(() => ({
    enabled: focused,
    bindings: bindByIds({
      "sidebar.view": (_evt, slot) => {
        const target = cycleViewTarget(view, (slot ?? 0) % 2 === 0 ? -1 : 1)
        if (target) setView(target)
      },
    }),
  }))

  // Search-mode chords — registered only while the query row shows. j/k are
  // deliberately absent: they are text here, so ctrl+n/ctrl+p walk the results.
  useBindings(() => ({
    enabled: focused && search.active,
    bindings: bindByIds({
      "sidebar.search.nav": (_evt, slot) => {
        if ((slot ?? 0) % 2 === 0) ctrl.moveDown()
        else ctrl.moveUp()
      },
      "sidebar.search.submit": () => {
        ctrl.selectCurrent()
        search.exit()
      },
      "sidebar.search.cancel": () => search.exit(),
    }),
  }))

  // Menu chords — the same j/k/enter the tree uses, retargeted at the menu
  // while it is up. No new bindings: an open menu is a mode, not a surface
  // with its own vocabulary.
  useBindings(() => ({
    enabled: focused && menu.open,
    bindings: bindByIds({
      "sidebar.nav": (_evt, slot) => menu.moveCursor((slot ?? 0) % 2 === 0 ? 1 : -1),
      "sidebar.select": () => menu.pickCurrent(),
    }),
  }))
  // Escape has no sidebar-scope registry entry outside search, so it binds
  // raw — the same escape hatch move mode uses in keys.ts.
  useBindings(() => ({
    enabled: focused && menu.open,
    bindings: [{ key: "escape", cmd: () => menu.close() }],
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
    selectedTaskId: props.selectedId,
    rowEls,
    onPress: (flatIndex, rowId) => {
      // Clicking a row while a menu is up dismisses it — otherwise the menu
      // would hang over a row it no longer describes.
      menu.close()
      setCursorIndex(flatIndex)
      activateRow(rowId)
    },
    onContextMenu: menu.openForRow,
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
      {search.active ? (
        <SidebarSearchInput query={search.query} matchCount={tree.flatIds.length} totalCount={tree.totalCount} />
      ) : null}
      <SidebarNavRail nav={props.nav ?? "terminal"} setNav={(next) => props.onNavChange?.(next)} />
      <SidebarViewTabs view={view} setView={setView} />
      <SidebarTreeBody
        rows={tree.rows}
        flatIndexOf={flatIndexOf}
        view={view}
        searching={search.active && search.query.trim().length > 0}
        shared={shared}
        onProjectContextMenu={menu.openForProject}
        movingProjectId={moveMode ? cursorProjectId : null}
        setScrollRef={(r) => {
          scrollRef.current = r
        }}
      />
      {props.zenActive ? <SidebarZenChip onZenClick={props.onZenClick} /> : null}
      {menu.open ? (
        <ContextMenu entries={menu.entries} cursor={menu.cursor} x={menu.x} y={menu.y} dims={dims} onPick={menu.pick} />
      ) : null}
      {/* Terminal dimensions are read so the body re-measures on resize. */}
      {dims.height < 0 ? <text>{""}</text> : null}
    </box>
  )
}
