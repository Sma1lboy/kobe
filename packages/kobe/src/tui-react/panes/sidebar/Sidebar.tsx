/** @jsxImportSource @opentui/react */

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
import { IN_PROGRESS_SPINNER, SPINNER_FRAME_MS } from "../../../tui/panes/sidebar/row-view"
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
  function exitSearch(_select: boolean): void {
    setSearchMode(false)
    setSearchQuery("")
    props.onSearchActiveChange?.(false)
  }

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

  const [branchTick, setBranchTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setBranchTick((n) => n + 1), MAIN_BRANCH_POLL_MS)
    return () => clearInterval(timer)
  }, [])
  const [spinnerFrame, setSpinnerFrame] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setSpinnerFrame((n) => (n + 1) % IN_PROGRESS_SPINNER.length), SPINNER_FRAME_MS)
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
  const totalRows = useMemo(
    () => flattenIds(buildRows(props.tasks, view, "", sortMode, projectFilterRepo)).length,
    [props.tasks, view, sortMode, projectFilterRepo],
  )

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

  const effectiveWidth = props.width ?? SIDEBAR_WIDTH
  const titleBudget = titleBudgetFor(effectiveWidth)
  const subtitleBudget = subtitleBudgetFor(effectiveWidth)

  const dims = useTerminalDimensions()
  const projectScrollMaxHeight = projectScrollMaxHeightFor(dims.height, projectRows.length)

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

  const [cursorIndex, setCursorIndexState] = useState(-1)
  const cursorRef = useRef(cursorIndex)
  const setCursorIndex = useCallback((next: number): void => {
    cursorRef.current = next
    setCursorIndexState(next)
  }, [])

  const projectScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const taskScrollRef = useRef<ScrollBoxRenderable | null>(null)
  const outerBoxRef = useRef<BoxRenderable | null>(null)
  const rowElsRef = useRef<Map<number, BoxRenderable> | null>(null)
  if (rowElsRef.current === null) rowElsRef.current = new Map()
  const rowEls = rowElsRef.current

  useEffect(() => {
    const el = outerBoxRef.current
    if (!el) return
    el.width = effectiveWidth
    el.flexShrink = 1
    el.minHeight = 0
  }, [effectiveWidth])

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

  useEffect(() => {
    const cur = cursorRef.current
    const next = resolveCursorTarget(props.selectedId, flatIds, cur)
    if (next !== cur) setCursorIndex(next)
  }, [props.selectedId, flatIds, setCursorIndex])

  const viewMountedRef = useRef(false)
  useEffect(() => {
    void view
    if (!viewMountedRef.current) {
      viewMountedRef.current = true
      return
    }
    setCursorIndex(flatIdsRef.current.length > 0 ? 0 : -1)
  }, [view, setCursorIndex])

  const filterMountedRef = useRef(false)
  useEffect(() => {
    if (!filterMountedRef.current) {
      filterMountedRef.current = true
      return
    }
    setCursorIndex(cursorIndexForProjectScope(rowsRef.current, projectFilterRepo))
  }, [projectFilterRepo, setCursorIndex])

  useEffect(() => {
    void searchQuery
    if (!searchMode) return
    setCursorIndex(flatIdsRef.current.length > 0 ? 0 : -1)
  }, [searchMode, searchQuery, setCursorIndex])

  function cycleView(delta: -1 | 1): void {
    const target = cycleViewTarget(view, delta)
    if (target) setView(target)
  }

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
