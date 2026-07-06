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

  // Active view; default to the working session. `[` / `]` cycle
  // through `VIEW_TABS`.
  const [view, setView] = createSignal<SidebarView>("active")

  // `/`-search state. `searchMode` flips on when the user presses `/`
  // and back off when they press enter (commits a selection) or esc
  // (cancels). The query is fuzz-matched against task title + repo
  // basename inside `buildRows`. While the mode is on, the inline
  // input row is rendered above the view switcher and the sidebar's
  // single-letter chords are de-registered (see keys.ts) so typed
  // letters reach the input rather than firing j/k/g/d/a/r/P/m.
  //
  // `prevSelectedIdBeforeSearch` is snapshotted on enter so esc can
  // restore the user to the task they were looking at before they
  // started searching — otherwise the cursor would drift to wherever
  // the last filtered match left it.
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
    // Both enter (`select=true`) and esc (`select=false`) just close
    // the search row. On enter, ctrl.selectCurrent has already fired
    // in keys.ts and set selectedId to the highlighted match; on esc
    // we leave selectedId alone — only the cursor moved during the
    // search, and the cursor-sync effect will glide back to the
    // already-selected task once `flatIds` returns to the unfiltered
    // list. We DON'T call props.onSelect on exit because the host
    // (app.tsx) pulls focus to the workspace on every select, which
    // is wrong for an esc — the user wanted to stay in the sidebar.
    setSearchMode(false)
    setSearchQuery("")
    props.onSearchActiveChange?.(false)
  }

  // Search-mode keystroke capture. We render the query as a plain
  // `<text>` rather than using opentui's `<input>` element — earlier
  // attempts with `<input>` ran into a stack of issues we couldn't
  // pin down (chars eaten on mount-race; reactive value prop wiping
  // the buffer on every keystroke; placeholder leaking into the
  // workspace after exit). A custom text-based input bypasses all of
  // it: when search mode is on, we subscribe to the renderer's
  // global keypress event, append printable chars to `searchQuery`,
  // and let `<text>{searchQuery()}</text>` re-render via Solid.
  //
  // The listener runs AFTER the keymap dispatch (which registers
  // first), so chords that already fired `preventDefault` are
  // skipped. Non-printable / modifier-prefixed keys are ignored.
  // Backspace pops the last char.
  createEffect(() => {
    if (!searchMode()) return
    const r = useRenderer()
    if (!r) return
    const listener = (evt: KeyEvent): void => {
      if (!focusedAccessor()) return
      // The printable/backspace/modifier policy is the shared reducer
      // (view-core.ts, shared with the React port); null = not ours.
      setSearchQuery((q) => searchQueryKeystroke(q, evt) ?? q)
    }
    r.keyInput.on("keypress", listener)
    onCleanup(() => r.keyInput.off("keypress", listener))
  })

  // Tick that busts each main row's branch-name memo on a fixed
  // interval. Cheap (one signal write per tick); the actual git call
  // only happens when a row is visible and re-renders. onCleanup pairs
  // the interval with the component lifetime (leak class 2, #104): the
  // app shell normally never unmounts the sidebar, but an embedder that
  // does must not leave a detached timer ticking a dead signal.
  const [branchTick, setBranchTick] = createSignal(0)
  const branchInterval = setInterval(() => setBranchTick((n) => n + 1), MAIN_BRANCH_POLL_MS)
  onCleanup(() => clearInterval(branchInterval))

  // Spinner frame tick for `in_progress` row badges. Single shared
  // counter so every running task animates in lockstep (reads as one
  // "system pulse" rather than a noisy mismatched twitch). Always on —
  // the cost is one signal write per 100ms and Solid only re-renders
  // the rows whose badge derivation actually reads `spinnerFrame()`.
  const [spinnerFrame, setSpinnerFrame] = createSignal(0)
  const spinnerInterval = setInterval(
    () => setSpinnerFrame((n) => (n + 1) % IN_PROGRESS_SPINNER.length),
    SPINNER_FRAME_MS,
  )
  onCleanup(() => clearInterval(spinnerInterval))

  // Filtered, flat row list for the active view. Recomputes only when
  // the upstream tasks accessor, the view, or the search query
  // changes. Search query is only applied when `searchMode` is on so
  // we don't keep filtering against stale query text after esc-cancel.
  //
  // Identity reconciliation (docs/DESIGN.md §5.5): every daemon
  // `task.snapshot` push deserializes ALL-new Task objects — including
  // the no-visual-change pushes from `setActiveTask`'s recency touch on
  // every task switch — so `buildRows` alone would feed `<For>` all-new
  // row objects each push and churn every row's renderables (the native
  // @opentui leak class fixed in filetree/rows.ts). `reconcileSidebarRows`
  // keeps the previous row object when its rendered fields are unchanged,
  // and returns the previous ARRAY when nothing changed at all so the
  // memo's value identity holds and downstream never notifies.
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
  // Total unfiltered count for the active view — used to show "N/total" in search mode.
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

  // Two-line card budgets. The width accessor is the Shell-driven splitter
  // width in the outer monitor and the live tmux pane width in the Tasks pane
  // (`useTerminalDimensions` → reflows on resize), so these recompute as the
  // user drags the pane. Splitting each task into a title line + a metadata
  // (branch · changes) line means the two no longer fight for one row, so the
  // title gets the WHOLE first line and the branch the whole second line —
  // each just truncated to its own line budget.
  const effectiveWidth = (): number => (props.width ? props.width() : SIDEBAR_WIDTH)
  // Reserved-cell math lives in view-core.ts (shared with the React port).
  const titleBudget = createMemo(() => titleBudgetFor(effectiveWidth()))
  const subtitleBudget = createMemo(() => subtitleBudgetFor(effectiveWidth()))

  // Hover tooltip (KOB): on a narrow rail the responsive columns hide the
  // branch and the title is ellipsised, so hovering a row pops a detail
  // overlay with the full title / branch / worktree path. We snapshot the
  // cursor coords from the mouse event to anchor it; `useTerminalDimensions`
  // clamps it inside the screen so a long path near the bottom/right edge
  // doesn't render off-screen. Cleared on mouse-out (guarded so a fast
  // row→row move doesn't clear the row we just entered).
  const dims = useTerminalDimensions()
  // PROJECTS is a separate scroll region above TASKS. Cap it so a repo-heavy
  // workspace can scroll projects without starving the task list; derive the
  // cap from terminal cells and clamp it to a small, predictable rail band.
  // Then shrink to the actual project rows (each card is 2 lines, no inter-card
  // gap) so a one-project workspace doesn't reserve the full cap as dead space.
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

  // Renderable refs for the split scroll machinery below.
  let projectScrollRef: ScrollBoxRenderable | undefined
  let taskScrollRef: ScrollBoxRenderable | undefined
  let outerBoxRef: BoxRenderable | undefined
  const rowEls = new Map<number, BoxRenderable>()

  // Apply the rail width imperatively, then restore flexShrink/minHeight in the
  // SAME effect. opentui's width setter force-zeroes flexShrink, which would
  // stop the rail shrinking to its bounded host parent and break list
  // scrolling (see the outer box's ref/comment below). Doing both here
  // guarantees flexShrink wins regardless of prop-application order, and the
  // effect re-runs on live pane resizes so a resize can't re-zero it.
  createEffect(() => {
    const w = props.width ? props.width() : SIDEBAR_WIDTH
    const el = outerBoxRef
    if (!el) return
    el.width = w
    el.flexShrink = 1
    el.minHeight = 0
  })

  // ---------- viewport follow ----------
  // The flat cursor still walks one ordered list, but rendering is now split:
  // PROJECTS and TASKS own separate scrollboxes so a tall task list cannot
  // push the project area away. Follow the cursor in whichever section owns
  // the current row. The geometry-based scroll is still important because row
  // heights vary (project cards are 2 lines; task cards are 3 with spacing).
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

  // Sync cursor from external selectedId. Deps are *only* the selected
  // id and the flat id list — we read `cursorIndex()` inside via
  // `untrack` so cursor moves from j/k don't refire this effect (which
  // would yank the cursor back to the selected task's position and
  // make navigation impossible).
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

  // Reset cursor to 0 on view switch — the previous index is meaningless
  // against the new filtered list. `on` so we react only to view
  // changes, not to upstream task churn. `defer: true` is load-bearing:
  // without it this fires once at MOUNT and clobbers the cursor the
  // sync-from-selectedId effect above just positioned — so a freshly
  // spawned Tasks pane (every new task session) snapped its highlight to
  // the first row instead of the task it was opened for. We only want the
  // reset on an actual later view switch; the initial position is owned by
  // the selectedId-sync effect.
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

  // Project filter changes replace the visible task universe; reset to the top
  // of the new scope instead of carrying over an index from the previous repo.
  createEffect(
    on(projectFilterRepo, (repo) => setCursorIndex(cursorIndexForProjectScope(rows(), repo)), { defer: true }),
  )

  // Reset cursor to 0 on every search query keystroke — keeps the
  // highlight landed on the top match instead of stranding it on a
  // now-hidden row. Only runs while search mode is on.
  createEffect(
    on([searchMode, searchQuery], () => {
      if (!searchMode()) return
      const ids = flatIds()
      setCursorIndex(ids.length > 0 ? 0 : -1)
    }),
  )

  /**
   * Cycle the view by `delta` (-1 = `[` / left, +1 = `]` / right). Wraps:
   * `[` from the leftmost lands on the rightmost and vice versa. Today
   * there are 2 views so both directions toggle, but the cycle shape is
   * preserved so a future third view drops in without a binding rewrite.
   * (An earlier session briefly switched to clamp on a misread of the
   * spec — Jackson confirmed loop is the intended behavior; the apparent
   * "[ goes right" bug was a pinyin-IME swallow.)
   */
  function cycleView(delta: -1 | 1): void {
    const target = cycleViewTarget(view(), delta)
    if (target) setView(target)
  }

  // Activate (jump to) a row — the single funnel for both the keyboard `enter`
  // path and the per-row `onMouseUp`. In a pinned-selection pane (see
  // {@link SidebarProps.pinnedSelection}) a jump to ANOTHER task snaps this
  // pane's cursor back to its pinned row so the backgrounded pane never strands
  // a stale cursor that reads as a second selection. A jump to the pinned row
  // itself, or any home pane, leaves the cursor where the click/keys put it.
  const activateRow = (id: string): void => {
    props.onActivate?.(id)
    if (!props.pinnedSelection) return
    const pinned = props.selectedId()
    if (!pinned || id === pinned) return
    const idx = flatIds().indexOf(pinned)
    if (idx >= 0) setCursorIndex(idx)
  }

  // Surface the cursor row's task id to the host (o/b/v target the cursor,
  // not `selectedId`). Derived from the same flatIds+cursorIndex pair the
  // sidebar's own d/a/r use, so all cursor-row actions agree on the target.
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
      // Keyboard `enter` path. Always sync the highlight, and — if
      // the host wired `onActivate` — fire it too so a single Enter
      // opens the task (e.g. attaches to its tmux session). Mouse
      // clicks still go through `props.onSelect` only via the
      // per-row `onMouseUp`, so a stray click never auto-launches.
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
