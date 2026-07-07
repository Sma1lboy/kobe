/** @jsxImportSource @opentui/react */
/**
 * React sidebar (issue #15, G3) — the `src/tui/panes/sidebar/Sidebar.tsx`
 * counterpart, the highest-Solid-density pane port. All list shaping /
 * cursor policy / budgets are the shared framework-free modules (`groups`,
 * `view-core`, `row-view`); this file owns only the React state machine.
 *
 * Translation notes vs the Solid original (full rationale lives there):
 *   - Signals → useState; memos → useMemo (row reconcile keeps its `prev`
 *     in a ref so daemon snapshot echoes preserve row identity).
 *   - The cursor is state + a ref written together: key handlers between
 *     renders must read the just-set index (Solid signals are sync; React
 *     state commits later), so `keys.ts` reads through `getCursorIndex`.
 *   - `defer: true` effects (view switch / project-filter reset) become
 *     mount-skip refs; `untrack` reads become ref reads.
 *   - The 10Hz spinner tick re-renders the pane unconditionally (Solid made
 *     it a conditional dependency per row). Accepted: the rail's tree is
 *     small and the tick doubles as the pull that surfaces poller results.
 */

import type { KeyEvent } from "@opentui/core"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  type SidebarProjectOption,
  type SidebarRow,
  type SidebarView,
  buildProjectOptions,
  buildRows,
  cursorIndexForProjectScope,
  flattenIds,
  reconcileSidebarRows,
  resolveCursorTarget,
  sidebarProjectKey,
  splitSidebarRows,
} from "../../../tui/panes/sidebar/groups"
import { SPINNER_FRAME_MS, SPINNER_TICK_CYCLE } from "../../../tui/panes/sidebar/row-view"
import {
  MAIN_BRANCH_POLL_MS,
  SIDEBAR_WIDTH,
  cycleViewTarget,
  projectScrollMaxHeightFor,
  projectTaskCountKey,
  searchQueryKeystroke,
  subtitleBudgetFor,
  titleBudgetFor,
} from "../../../tui/panes/sidebar/view-core"
import { useT } from "../../i18n"
import { useSidebarBindings } from "./keys"
import { SidebarPanel } from "./panel"
import type { SidebarRowCardSharedProps } from "./row-cards"
import type { SidebarHover, SidebarProps } from "./types"

export type { ChatRunState, SidebarHover, SidebarProps } from "./types"

export function Sidebar(props: SidebarProps) {
  const t = useT()
  const focused = props.focused ?? true
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  const [view, setView] = useState<SidebarView>("active")
  const [searchMode, setSearchMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [localProjectFilter, setLocalProjectFilter] = useState<string | null>(null)
  const projectFilter = props.projectFilter !== undefined ? props.projectFilter : localProjectFilter
  const onProjectFilterChange = props.onProjectFilterChange
  const setProjectFilter = useCallback(
    (repo: string | null): void => {
      if (onProjectFilterChange) onProjectFilterChange(repo)
      else setLocalProjectFilter(repo)
    },
    [onProjectFilterChange],
  )

  function enterSearch(): void {
    setSearchQuery("")
    setSearchMode(true)
    props.onSearchActiveChange?.(true)
  }
  // Enter and esc both just close the search row; selection semantics are
  // handled by keys.ts (see the Solid original's exitSearch comment).
  function exitSearch(_select: boolean): void {
    setSearchMode(false)
    setSearchQuery("")
    props.onSearchActiveChange?.(false)
  }

  // Search-mode keystroke capture on the renderer's global keypress event —
  // registered AFTER the keymap dispatcher, so chords that preventDefault'd
  // are skipped by the shared reducer. Same custom-text-input rationale as
  // the Solid original (opentui <input> misbehaved).
  const renderer = useRenderer()
  useEffect(() => {
    if (!searchMode || !renderer) return
    const listener = (evt: KeyEvent): void => {
      if (!focusedRef.current) return
      setSearchQuery((q) => searchQueryKeystroke(q, evt) ?? q)
    }
    renderer.keyInput.on("keypress", listener)
    return () => {
      renderer.keyInput.off("keypress", listener)
    }
  }, [searchMode, renderer])

  // Branch/changes poll tick + shared spinner frame (one system pulse).
  const [branchTick, setBranchTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setBranchTick((n) => n + 1), MAIN_BRANCH_POLL_MS)
    return () => clearInterval(timer)
  }, [])
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  useEffect(() => {
    // Common-multiple cycle — rows reduce modulo their own engine frame set.
    const timer = setInterval(() => setSpinnerFrame((n) => (n + 1) % SPINNER_TICK_CYCLE), SPINNER_FRAME_MS)
    return () => clearInterval(timer)
  }, [])

  const sortMode = props.sortMode ?? "default"
  const projectOptions = useMemo<readonly SidebarProjectOption[]>(
    () => buildProjectOptions(props.tasks, view),
    [props.tasks, view],
  )
  const projectFilterOption = useMemo<SidebarProjectOption | null>(() => {
    if (!projectFilter) return null
    const key = sidebarProjectKey(projectFilter)
    return projectOptions.find((option) => sidebarProjectKey(option.repo) === key) ?? null
  }, [projectFilter, projectOptions])
  const projectFilterRepo = projectFilterOption?.repo ?? null
  const projectFilterLabel = projectFilterOption?.label ?? "all"
  const projectFilterCount = projectFilterOption
    ? projectFilterOption.count
    : projectOptions.reduce((sum, entry) => sum + entry.count, 0)
  const projectFilterCountLabel = `${projectFilterCount} ${t(projectTaskCountKey(projectFilterCount))}`

  // Identity-reconciled row list (docs/DESIGN.md §5.5): keep previous row
  // objects (and the previous ARRAY when nothing changed) so daemon
  // snapshot echoes don't churn row renderables.
  const prevRowsRef = useRef<readonly SidebarRow[]>([])
  const rows = useMemo<readonly SidebarRow[]>(() => {
    const next = reconcileSidebarRows(
      prevRowsRef.current,
      buildRows(props.tasks, view, searchMode ? searchQuery : "", sortMode, projectFilterRepo),
    )
    prevRowsRef.current = next
    return next
  }, [props.tasks, view, searchMode, searchQuery, sortMode, projectFilterRepo])
  const flatIds = useMemo(() => flattenIds(rows), [rows])
  const flatIdsRef = useRef(flatIds)
  flatIdsRef.current = flatIds
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const { projectRows, taskRows } = useMemo(() => splitSidebarRows(rows), [rows])
  // Total unfiltered count for the active view — the "N/total" in search mode.
  const totalRows = useMemo(
    () => flattenIds(buildRows(props.tasks, view, "", sortMode, projectFilterRepo)).length,
    [props.tasks, view, sortMode, projectFilterRepo],
  )

  // Drop a stale project filter when its repo disappears / only one repo left.
  useEffect(() => {
    if (
      projectFilter !== null &&
      projectOptions.length > 0 &&
      (projectOptions.length <= 1 || projectFilterOption === null)
    ) {
      setProjectFilter(null)
    }
  }, [projectFilter, projectOptions, projectFilterOption, setProjectFilter])

  function cycleProjectFilter(): void {
    if (projectOptions.length <= 1) {
      setProjectFilter(null)
      return
    }
    const activeKey = projectFilterRepo ? sidebarProjectKey(projectFilterRepo) : null
    const idx =
      activeKey === null ? -1 : projectOptions.findIndex((option) => sidebarProjectKey(option.repo) === activeKey)
    setProjectFilter(projectOptions[idx + 1]?.repo ?? null)
  }

  // Two-line card budgets from the live width (view-core math).
  const effectiveWidth = props.width ?? SIDEBAR_WIDTH
  const titleBudget = titleBudgetFor(effectiveWidth)
  const subtitleBudget = subtitleBudgetFor(effectiveWidth)

  const dims = useTerminalDimensions()
  const projectScrollMaxHeight = projectScrollMaxHeightFor(dims.height, projectRows.length)

  // Hover tooltip state; mirrored to the host and cleared on unmount.
  const [hover, setLocalHover] = useState<SidebarHover | null>(null)
  const hoverRef = useRef(hover)
  hoverRef.current = hover
  const onHoverChangeRef = useRef(props.onHoverChange)
  onHoverChangeRef.current = props.onHoverChange
  const setHover = useCallback((next: SidebarHover | null): void => {
    setLocalHover(next)
    onHoverChangeRef.current?.(next)
  }, [])
  const clearHoverForTask = useCallback(
    (taskId: string): void => {
      if (hoverRef.current?.task.id !== taskId) return
      setHover(null)
    },
    [setHover],
  )
  useEffect(
    () => () => {
      onHoverChangeRef.current?.(null)
    },
    [],
  )

  // Cursor: state + ref written together so key handlers between renders
  // read the just-set index (see header).
  const [cursorIndex, setCursorIndexState] = useState(-1)
  const cursorRef = useRef(cursorIndex)
  const setCursorIndex = useCallback((next: number): void => {
    cursorRef.current = next
    setCursorIndexState(next)
  }, [])

  // Renderable refs for the split scroll machinery.
  const projectScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const taskScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const outerBoxRef = useRef<BoxRenderable | null>(null)
  const rowElsRef = useRef<Map<number, BoxRenderable> | null>(null)
  if (rowElsRef.current === null) rowElsRef.current = new Map()
  const rowEls = rowElsRef.current

  // Apply the rail width imperatively, restoring flexShrink/minHeight in the
  // same effect (opentui's width setter force-zeroes flexShrink — see the
  // Solid original for the full story).
  useEffect(() => {
    const el = outerBoxRef.current
    if (!el) return
    el.width = effectiveWidth
    el.flexShrink = 1
    el.minHeight = 0
  }, [effectiveWidth])

  // Viewport follow: scroll whichever section owns the cursor row.
  useEffect(() => {
    const row = rows.find((r) => r.flatIndex === cursorIndex)
    if (!row) return
    const scrollRef = row.task.kind === "main" ? projectScrollRef.current : taskScrollRef.current
    if (!scrollRef) return
    if (scrollRef.viewport.height <= 0) return
    const el = rowEls.get(cursorIndex)
    if (!el) return
    scrollRef.scrollChildIntoView(el.id)
  }, [cursorIndex, rows, rowEls])

  // Sync cursor from external selectedId — deps are ONLY the selected id and
  // the flat id list; the current cursor is read via ref (Solid's untrack).
  useEffect(() => {
    const cur = cursorRef.current
    const next = resolveCursorTarget(props.selectedId, flatIds, cur)
    if (next !== cur) setCursorIndex(next)
  }, [props.selectedId, flatIds, setCursorIndex])

  // Reset cursor on a LATER view switch only (Solid's `defer: true`): the
  // mount-time position is owned by the selectedId sync above.
  const viewMountedRef = useRef(false)
  useEffect(() => {
    // Dependency-only invalidation key: reset on view switches, not data churn.
    void view
    if (!viewMountedRef.current) {
      viewMountedRef.current = true
      return
    }
    setCursorIndex(flatIdsRef.current.length > 0 ? 0 : -1)
  }, [view, setCursorIndex])

  // Project filter changes replace the visible task universe (defer'd too).
  const filterMountedRef = useRef(false)
  useEffect(() => {
    if (!filterMountedRef.current) {
      filterMountedRef.current = true
      return
    }
    setCursorIndex(cursorIndexForProjectScope(rowsRef.current, projectFilterRepo))
  }, [projectFilterRepo, setCursorIndex])

  // Land the highlight on the top match on every search keystroke.
  useEffect(() => {
    // Dependency-only invalidation key: every keystroke re-lands the cursor.
    void searchQuery
    if (!searchMode) return
    setCursorIndex(flatIdsRef.current.length > 0 ? 0 : -1)
  }, [searchMode, searchQuery, setCursorIndex])

  function cycleView(delta: -1 | 1): void {
    const target = cycleViewTarget(view, delta)
    if (target) setView(target)
  }

  // Single activation funnel (keyboard enter + row onMouseUp). In a
  // pinned-selection pane a jump to ANOTHER task snaps the cursor back to
  // the pinned row (see the Solid original).
  const activateRow = (id: string): void => {
    props.onActivate?.(id)
    if (!props.pinnedSelection) return
    const pinned = props.selectedId
    if (!pinned || id === pinned) return
    const idx = flatIdsRef.current.indexOf(pinned)
    if (idx >= 0) setCursorIndex(idx)
  }
  const activateRowRef = useRef(activateRow)
  activateRowRef.current = activateRow

  // Surface the cursor row's task id to the host (o/b/v target the cursor).
  const onCursorChangeRef = useRef(props.onCursorChange)
  onCursorChangeRef.current = props.onCursorChange
  useEffect(() => {
    onCursorChangeRef.current?.(
      cursorIndex >= 0 && cursorIndex < flatIds.length ? (flatIds[cursorIndex] ?? null) : null,
    )
  }, [cursorIndex, flatIds])

  useSidebarBindings({
    focused,
    getCursorIndex: () => cursorRef.current,
    setCursorIndex,
    flatTaskIds: flatIds,
    onSelect: (id) => {
      // Keyboard `enter`: sync the highlight AND activate (single Enter
      // opens the task). Mouse clicks route through the row's onMouseUp.
      props.onSelect(id)
      activateRowRef.current(id)
    },
    onDeleteRequest: (id) => props.onDeleteRequest?.(id),
    onArchiveRequest: (id) => props.onArchiveRequest?.(id),
    onLocalMergeRequest: (id) => props.onLocalMergeRequest?.(id),
    moveMode: props.moveMode,
    onMoveRequest: (id, delta) => props.onMoveRequest?.(id, delta),
    onMoveModeExit: () => props.onMoveModeExit?.(),
    onRenameRequest: (id) => props.onRenameRequest?.(id),
    onPinRequest: (id) => props.onPinRequest?.(id),
    onPreviewToggleRequest: (id) => props.onPreviewToggleRequest?.(id),
    onViewSwitch: (delta) => cycleView(delta),
    onSortModeToggle: () => props.onSortModeToggle?.(),
    onProjectFilterToggle: () => cycleProjectFilter(),
    searchMode,
    onSearchEnter: () => enterSearch(),
    onSearchExit: (select) => exitSearch(select),
  })

  const rowCardShared: SidebarRowCardSharedProps = {
    selectedId: props.selectedId,
    cursorIndex,
    setCursorIndex,
    rowEls,
    onSelect: props.onSelect,
    activateRow,
    activateOnClick: props.activateOnClick,
    setHover,
    clearHoverForTask,
    branchTick,
    spinnerFrame,
    titleBudget,
    subtitleBudget,
    chatRunState: props.chatRunState,
    engineState: props.engineState,
    taskJobs: props.taskJobs,
    worktreeChanges: props.worktreeChanges,
    moveMode: props.moveMode,
  }

  return (
    <SidebarPanel
      rootRef={(r) => {
        outerBoxRef.current = r
      }}
      focused={focused}
      view={view}
      setView={setView}
      sortMode={sortMode}
      hasSortToggle={props.sortMode !== undefined}
      onSortModeToggle={props.onSortModeToggle}
      searchMode={searchMode}
      searchQuery={searchQuery}
      flatIds={flatIds}
      totalRows={totalRows}
      projectRows={projectRows}
      taskRows={taskRows}
      hasTaskRows={taskRows.length > 0}
      projectOptions={projectOptions}
      projectFilterRepo={projectFilterRepo}
      projectFilterLabel={projectFilterLabel}
      projectFilterCountLabel={projectFilterCountLabel}
      cycleProjectFilter={cycleProjectFilter}
      projectScrollMaxHeight={projectScrollMaxHeight}
      setProjectScrollRef={(r) => {
        projectScrollRef.current = r
      }}
      setTaskScrollRef={(r) => {
        taskScrollRef.current = r
      }}
      rowCardShared={rowCardShared}
      headerStatus={props.headerStatus}
      onHeaderStatusClick={props.onHeaderStatusClick}
      onAddTask={props.onAddTask}
      zenActive={props.zenActive}
      onZenClick={props.onZenClick}
      hover={hover}
      dims={dims}
      renderHoverFallback={!props.onHoverChange}
    />
  )
}
