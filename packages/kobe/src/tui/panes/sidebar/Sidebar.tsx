import { t } from "@/tui/i18n"
import type { BoxRenderable, KeyEvent, ScrollBoxRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import {
  type SidebarProjectOption,
  type SidebarRow,
  type SidebarView,
  type TaskSortMode,
  buildProjectOptions,
  buildRows,
  cursorIndexForProjectScope,
  flattenIds,
  reconcileSidebarRows,
  resolveCursorTarget,
  sidebarProjectKey,
  splitSidebarRows,
} from "./groups"
import { useSidebarBindings } from "./keys"
import { SidebarPanel } from "./panel"
import type { SidebarRowCardSharedProps } from "./row-cards"
import { IN_PROGRESS_SPINNER, SPINNER_FRAME_MS } from "./row-view"
import type { SidebarHover, SidebarProps } from "./types"
import {
  MAIN_BRANCH_POLL_MS,
  SIDEBAR_WIDTH,
  cycleViewTarget,
  projectScrollMaxHeightFor,
  projectTaskCountKey,
  searchQueryKeystroke,
  subtitleBudgetFor,
  titleBudgetFor,
} from "./view-core"

export type { ChatRunState, SidebarHover, SidebarProps } from "./types"
export { approxCellWidth } from "./hover-tooltip"
export { MAIN_BRANCH_POLL_MS } from "./view-core"

export function Sidebar(props: SidebarProps) {
  const focusedAccessor = () => (props.focused ? props.focused() : true)

  const [view, setView] = createSignal<SidebarView>("active")

  const [searchMode, setSearchMode] = createSignal(false)
  const [searchQuery, setSearchQuery] = createSignal("")
  const [localProjectFilter, setLocalProjectFilter] = createSignal<string | null>(null)
  const projectFilter = (): string | null => props.projectFilter?.() ?? localProjectFilter()
  const setProjectFilter = (repo: string | null): void => {
    if (props.onProjectFilterChange) props.onProjectFilterChange(repo)
    else setLocalProjectFilter(repo)
  }

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

  createEffect(() => {
    if (!searchMode()) return
    const r = useRenderer()
    if (!r) return
    const listener = (evt: KeyEvent): void => {
      if (!focusedAccessor()) return
      setSearchQuery((q) => searchQueryKeystroke(q, evt) ?? q)
    }
    r.keyInput.on("keypress", listener)
    onCleanup(() => r.keyInput.off("keypress", listener))
  })

  const [branchTick, setBranchTick] = createSignal(0)
  const branchInterval = setInterval(() => setBranchTick((n) => n + 1), MAIN_BRANCH_POLL_MS)
  onCleanup(() => clearInterval(branchInterval))

  const [spinnerFrame, setSpinnerFrame] = createSignal(0)
  const spinnerInterval = setInterval(
    () => setSpinnerFrame((n) => (n + 1) % IN_PROGRESS_SPINNER.length),
    SPINNER_FRAME_MS,
  )
  onCleanup(() => clearInterval(spinnerInterval))

  const sortMode = (): TaskSortMode => props.sortMode?.() ?? "default"
  const projectOptions = createMemo<readonly SidebarProjectOption[]>(() => buildProjectOptions(props.tasks(), view()))
  const projectFilterOption = createMemo<SidebarProjectOption | null>(() => {
    const repo = projectFilter()
    if (!repo) return null
    const key = sidebarProjectKey(repo)
    return projectOptions().find((option) => sidebarProjectKey(option.repo) === key) ?? null
  })
  const projectFilterRepo = createMemo(() => projectFilterOption()?.repo ?? null)
  const projectFilterLabel = createMemo(() => projectFilterOption()?.label ?? "all")
  const projectFilterCount = createMemo(() => {
    const option = projectFilterOption()
    return option ? option.count : projectOptions().reduce((sum, entry) => sum + entry.count, 0)
  })
  const projectFilterCountLabel = createMemo(() => {
    const count = projectFilterCount()
    return `${count} ${t(projectTaskCountKey(count))}`
  })
  const rows = createMemo<readonly SidebarRow[]>(
    (prev) =>
      reconcileSidebarRows(
        prev,
        buildRows(props.tasks(), view(), searchMode() ? searchQuery() : "", sortMode(), projectFilterRepo()),
      ),
    [],
  )
  const flatIds = createMemo(() => flattenIds(rows()))
  const rowSections = createMemo(() => splitSidebarRows(rows()))
  const projectRows = createMemo(() => rowSections().projectRows)
  const taskRows = createMemo(() => rowSections().taskRows)
  const rowByFlatIndex = createMemo(() => {
    const out = new Map<number, SidebarRow>()
    for (const row of rows()) out.set(row.flatIndex, row)
    return out
  })
  const totalRows = createMemo(
    () => flattenIds(buildRows(props.tasks(), view(), "", sortMode(), projectFilterRepo())).length,
  )
  const hasTaskRows = createMemo(() => taskRows().length > 0)

  createEffect(() => {
    const repo = projectFilter()
    const options = projectOptions()
    if (repo !== null && options.length > 0 && (options.length <= 1 || projectFilterOption() === null)) {
      setProjectFilter(null)
    }
  })

  function cycleProjectFilter(): void {
    const options = projectOptions()
    if (options.length <= 1) {
      setProjectFilter(null)
      return
    }
    const active = projectFilterRepo()
    const activeKey = active ? sidebarProjectKey(active) : null
    const idx = activeKey === null ? -1 : options.findIndex((option) => sidebarProjectKey(option.repo) === activeKey)
    const next = options[idx + 1]
    setProjectFilter(next?.repo ?? null)
  }

  const effectiveWidth = (): number => (props.width ? props.width() : SIDEBAR_WIDTH)
  const titleBudget = createMemo(() => titleBudgetFor(effectiveWidth()))
  const subtitleBudget = createMemo(() => subtitleBudgetFor(effectiveWidth()))

  const dims = useTerminalDimensions()
  const projectScrollMaxHeight = createMemo(() => projectScrollMaxHeightFor(dims().height, projectRows().length))
  const [hover, setLocalHover] = createSignal<SidebarHover | null>(null)
  const setHover = (next: SidebarHover | null): void => {
    setLocalHover(next)
    props.onHoverChange?.(next)
  }
  const clearHoverForTask = (taskId: string): void => {
    if (hover()?.task.id !== taskId) return
    setHover(null)
  }
  onCleanup(() => props.onHoverChange?.(null))

  const [cursorIndex, setCursorIndex] = createSignal<number>(-1)

  let projectScrollRef: ScrollBoxRenderable | undefined
  let taskScrollRef: ScrollBoxRenderable | undefined
  let outerBoxRef: BoxRenderable | undefined
  const rowEls = new Map<number, BoxRenderable>()

  createEffect(() => {
    const w = props.width ? props.width() : SIDEBAR_WIDTH
    const el = outerBoxRef
    if (!el) return
    el.width = w
    el.flexShrink = 1
    el.minHeight = 0
  })

  createEffect(
    on([cursorIndex, rows], ([i]) => {
      const row = rowByFlatIndex().get(i)
      if (!row) return
      const scrollRef = row.task.kind === "main" ? projectScrollRef : taskScrollRef
      if (!scrollRef) return
      if (scrollRef.viewport.height <= 0) return
      const el = rowEls.get(i)
      if (!el) return
      scrollRef.scrollChildIntoView(el.id)
    }),
  )

  createEffect(
    on(
      () => [props.selectedId(), flatIds()] as const,
      ([id, ids]) => {
        const cur = untrack(cursorIndex)
        const next = resolveCursorTarget(id, ids, cur)
        if (next !== cur) setCursorIndex(next)
      },
    ),
  )

  createEffect(
    on(
      view,
      () => {
        const ids = flatIds()
        setCursorIndex(ids.length > 0 ? 0 : -1)
      },
      { defer: true },
    ),
  )

  createEffect(
    on(projectFilterRepo, (repo) => setCursorIndex(cursorIndexForProjectScope(rows(), repo)), { defer: true }),
  )

  createEffect(
    on([searchMode, searchQuery], () => {
      if (!searchMode()) return
      const ids = flatIds()
      setCursorIndex(ids.length > 0 ? 0 : -1)
    }),
  )

  function cycleView(delta: -1 | 1): void {
    const target = cycleViewTarget(view(), delta)
    if (target) setView(target)
  }

  const activateRow = (id: string): void => {
    props.onActivate?.(id)
    if (!props.pinnedSelection) return
    const pinned = props.selectedId()
    if (!pinned || id === pinned) return
    const idx = flatIds().indexOf(pinned)
    if (idx >= 0) setCursorIndex(idx)
  }

  createEffect(
    on([cursorIndex, flatIds] as const, ([idx, ids]) => {
      props.onCursorChange?.(idx >= 0 && idx < ids.length ? ids[idx]! : null)
    }),
  )

  useSidebarBindings({
    focused: focusedAccessor,
    cursorIndex,
    setCursorIndex,
    flatTaskIds: flatIds,
    onSelect: (id) => {
      props.onSelect(id)
      activateRow(id)
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
        outerBoxRef = r
      }}
      focused={focusedAccessor}
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
      hasTaskRows={hasTaskRows}
      projectOptions={projectOptions}
      projectFilterRepo={projectFilterRepo}
      projectFilterLabel={projectFilterLabel}
      projectFilterCountLabel={projectFilterCountLabel}
      cycleProjectFilter={cycleProjectFilter}
      projectScrollMaxHeight={projectScrollMaxHeight}
      setProjectScrollRef={(r) => {
        projectScrollRef = r
      }}
      setTaskScrollRef={(r) => {
        taskScrollRef = r
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
