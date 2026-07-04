/**
 * kobe sidebar pane (Stream F → Wave 4.A → Wave 4.5).
 *
 * Wave 4.5 reverses Wave 4.A's repo grouping; the list is NOT grouped
 * per project. Instead it renders as two flat sections — the PROJECTS
 * (repo-root `main` rows) on top, a divider, then ALL the TASKS
 * (worktrees) flat below (Jackson's call). Two views switch with `[`/`]`:
 *
 *   ┌───────────────────────────────────────┐
 *   │ KOBE                       v0.6.10     │
 *   │                                        │
 *   │ Working session   Archives             │
 *   │                                        │
 *   │ PROJECTS ──────────────────────────    │
 *   │ ★ kobe                                 │
 *   │   main                       +3 −1     │
 *   │ ★ pochi                                │
 *   │   feat/login-fix                       │
 *   │                                        │
 *   │ TASKS ─────────────────────────────    │
 *   │ ▌⠹ fix login redirect bug    working   │
 *   │ ▌  feat/login-fix            +12 −3     │
 *   │                                        │
 *   │   ○ add password reset                 │
 *   │     backlog                            │
 *   └───────────────────────────────────────┘
 *
 * Each section gets a small BOLD CAPS header + trailing rule. A PROJECT
 * row is a two-line card like a task: line 1 = ★ (an animated spinner
 * while its repo-root session is live) + repo name; line 2 = the repo
 * root's current branch + the `+N −M` uncommitted-change chip. (The repo
 * dir moved to the hover tooltip.) A TASK row is the same two-line card:
 * line 1 = status badge + title + a `working` chip while the engine
 * streams; line 2 = the branch (or a status word when the task has no
 * branch yet) + the `+N −M` change chip. Tasks carry a trailing blank
 * line so each reads as its own card; projects sit tight. The cursor row
 * gets a left accent ▌ and a subtle background tint; the active row keeps
 * a dimmer ▌ when the cursor moves off it.
 *
 * Loading is driven by `task.status === "in_progress"` (the Tasks pane's
 * only liveness signal — chatRunState is unwired there) or a live engine
 * handle when the outer monitor passes chatRunState: the badge animates
 * (braille spinner) and a `working` chip appears.
 *
 * The active view shows tasks where `task.archived === false`; the
 * archived view shows the rest. `a` on a row toggles its archived flag
 * (non-destructive; the worktree, the branch, and the chat history all
 * stay).
 *
 * The sidebar width is a documented hardcode (CLAUDE.md "flex-first,
 * hardcode last"): convention rationale — matches the direct-tmux Tasks pane
 * navigator width, wide enough for view tabs and useful task titles.
 *
 * Status badges (●○) still render on per-task rows as a visual hint of
 * the underlying `task.status` (the orchestrator's concurrency cap and
 * lifecycle still depend on it), but the sidebar no longer groups
 * by status, by repo, or by anything else — only the active-view
 * filter applies.
 *
 * Cursor / nav: a Solid signal `cursorIndex` indexes the *flat*
 * navigable task list within the active view. View switches reset the
 * cursor to 0. `enter` selects, `d` deletes, `a` toggles archive,
 * `M` starts local merge,
 * `[`/`]` switches view, `g g` jumps to top, `G` jumps to bottom.
 *
 * Reactivity: every prop is an `Accessor`. We never `.map()` arrays in
 * JSX — `For` is used so Solid keeps the row list reactive. The view
 * filter and row build recompute via `createMemo` only when their
 * inputs change.
 *
 * Focus: `props.focused` defaults to `() => true` so embedders that
 * don't yet thread the focus signal still get a working sidebar.
 */

import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import { t } from "@/tui/i18n"
import type { Task } from "@/types/task"
import type { KeyEvent } from "@opentui/core"
import { type BoxRenderable, type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js"
import { useTheme as _useTheme } from "../../context/theme"

/**
 * Legacy chat-run-state shape kept as an inert type so older
 * callers don't break their imports. Always-empty in v0.6 — the
 * spinner derives "in progress" from `Task.status` alone now.
 */
export type ChatRunState = "running" | "awaiting_input" | "idle"

/** Default sidebar width — task-list rail matching the tmux Tasks pane. */
const SIDEBAR_WIDTH = 32
void _useTheme
import { useTheme } from "../../context/theme"
import { truncateEnd, truncateStart } from "../../lib/truncate"
import { currentBranch, pollCurrentBranch } from "./git-head"
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
  repoBasename,
  resolveCursorTarget,
  sidebarProjectKey,
  splitSidebarRows,
} from "./groups"
import { useSidebarBindings } from "./keys"
import { spacedTitle, truncateTitle } from "./labels"
import {
  IN_PROGRESS_SPINNER,
  SPINNER_FRAME_MS,
  type SidebarTone,
  buildSidebarRowView,
  prCheckChip,
  withSpinnerFrame,
} from "./row-view"
import { type WorktreeChanges, pickPushedChanges, sameWorktreeChanges } from "./worktree-changes"
import { pollWorktreeChanges, worktreeChanges } from "./worktree-changes-poller"

export type SidebarProps = {
  tasks: Accessor<readonly Task[]>
  selectedId: Accessor<string | null>
  onSelect: (id: string) => void
  /**
   * Fires on keyboard `enter` (NOT on mouse click). v0.6 wires this
   * to "open the selected task in the workspace + launch tmux";
   * mouse click stays a plain highlight via {@link onSelect} so
   * accidental clicks don't suspend the renderer.
   */
  onActivate?: (taskId: string) => void
  /**
   * When true, a mouse click on a row fires {@link onActivate} (not
   * just {@link onSelect}). Off in the outer app — there activate is a
   * **Handover** that suspends the renderer, so a stray click must not
   * launch. The **Tasks pane** opts in: its activate is a cheap,
   * reversible `tmux switch-client`, so click-to-switch is the natural
   * affordance.
   */
  activateOnClick?: boolean
  /**
   * This pane's selection is PINNED to its own task — a task-bound Tasks pane
   * no-ops {@link onSelect} so `selectedId` never follows clicks. Without this,
   * clicking/Entering another project jumps the client away (via
   * {@link onActivate}) but leaves THIS backgrounded pane's cursor stranded on
   * the jumped-to row; switching back then shows that stale cursor as a second
   * selection while the pinned task is the one actually open. When set, a
   * jump-away snaps the cursor back to the pinned row. Off (home pane) keeps the
   * old behaviour, where `selectedId` follows and the cursor tracks it.
   */
  pinnedSelection?: boolean
  focused?: Accessor<boolean>
  onDeleteRequest?: (taskId: string) => void
  /**
   * Archive-toggle callback. Wave 4.5: pressing `a` flips the cursor
   * task's `archived` flag, which moves it between the Working session
   * and Archives views.
   */
  onArchiveRequest?: (taskId: string) => void
  /** Local merge callback. Pressing Shift+M asks the parent to start the merge flow. */
  onLocalMergeRequest?: (taskId: string) => void
  /**
   * Optional task-reorder mode. In this mode the sidebar keeps the same
   * cursor row selected, but j/k ask the parent to move that row up/down
   * in the persisted task order. Used by the tmux Tasks pane.
   */
  moveMode?: Accessor<boolean>
  onMoveRequest?: (taskId: string, delta: -1 | 1) => void
  onMoveModeExit?: () => void
  /**
   * Rename callback. Pressing `r` on the cursor task emits this with
   * the task id; the parent (app.tsx) opens an input dialog defaulted
   * to the current title and on submit calls `orchestrator.setTitle`.
   */
  onRenameRequest?: (taskId: string) => void
  /**
   * Pin-toggle callback. Pressing Shift+P on the cursor task emits
   * this; the parent calls `orchestrator.setPinned`. Sidebar stays
   * stateless of the toggle.
   */
  onPinRequest?: (taskId: string) => void
  onPreviewToggleRequest?: (taskId: string) => void
  /** Display ordering for task rows. Defaults to the persisted/manual order. */
  sortMode?: Accessor<TaskSortMode>
  /** Cycle the display ordering (`t`). */
  onSortModeToggle?: () => void
  /** Global project scope for task rows. Defaults to local state for legacy embedders. */
  projectFilter?: Accessor<string | null>
  /** Update the global project scope. */
  onProjectFilterChange?: (repo: string | null) => void
  /**
   * Fires when the `/`-search filter opens or closes. Lifted out of
   * the sidebar so the app-level Shell can gate its sidebar-scoped
   * plain-letter bindings (`n` / `s` / `q` in app-keymap.tsx) on
   * `!sidebarSearchActive()` — otherwise typing `n` / `s` / `q` into
   * the search query would fire those chords and steal the
   * keystroke before it could reach the input.
   */
  onSearchActiveChange?: (active: boolean) => void
  /**
   * Fires with the task id under the CURSOR whenever it changes (j/k nav,
   * click, view/filter reset). The Tasks-pane host needs this because its
   * own host-scoped chords (o/b/v) must act on the highlighted row, not on
   * `selectedId` — which in a home pane follows the active-task channel, not
   * the cursor (d/a/r already target the cursor via the sidebar's own
   * bindings). Fires `null` when no row is under the cursor. Optional; hosts
   * that don't need it just don't wire it.
   */
  onCursorChange?: (taskId: string | null) => void
  /**
   * Optional width override. When omitted, falls back to {@link SIDEBAR_WIDTH}.
   * Wired by the Shell so the sidebar↔workspace splitter can resize the pane
   * at runtime. Reactive — changing the accessor's value reflows immediately.
   */
  width?: Accessor<number>
  /**
   * Optional status chip in the `kobe` brand header — the Tasks pane wires
   * the version / "update available" chip here (it moved up from the footer's
   * old `── system ──` block). It sits in the left cluster right after the
   * KOBE name. `emphasize: true` paints it in the warning colour (an update is
   * waiting); omit / return `null` to hide it.
   */
  headerStatus?: Accessor<{ label: string; emphasize: boolean } | null>
  /** Click handler for {@link headerStatus} — e.g. open the update page. */
  onHeaderStatusClick?: () => void
  /**
   * Optional new-task affordance: when wired, a clickable `+` renders at the
   * end of the brand-header cluster (after the version) and fires this — the
   * SAME create flow as the `n` chord. Omitted (e.g. the deprecated outer
   * monitor) renders no `+`.
   */
  onAddTask?: () => void
  /**
   * Whether the ChatTab is in Zen mode (the file/terminal panes collapsed to
   * the engine). When true, a small `☯ ZEN` indicator renders at the rail's
   * bottom-left so the kept Tasks pane shows the mode and reminds the user of
   * the `prefix`+space exit chord. Polled from the window's `@kobe_zen_panes`
   * option by the Tasks-pane host.
   */
  zenActive?: Accessor<boolean>
  /**
   * Click handler for the `☯ ZEN` badge — toggles zen back off (the mouse
   * counterpart to the `prefix`+space exit chord). Wired by the Tasks-pane
   * host to the global zen toggle.
   */
  onZenClick?: () => void
  /**
   * Live per-tab engine state, keyed by `${taskId}:${tabId}` (see
   * {@link chatRunStateKey} in `orchestrator/core.ts`). The sidebar
   * spinner animates only when a row's task has at least one tab in
   * the `"running"` state — i.e. an actual live engine handle — so
   * interrupting a turn (which kills the handle but keeps
   * `task.status === "in_progress"` because the *task* is still
   * active) immediately stops the dots. Optional so embedders that
   * don't have the orchestrator handy can still mount the sidebar
   * (the spinner falls back to a static "active" badge).
   */
  chatRunState?: Accessor<ReadonlyMap<string, ChatRunState>>
  /**
   * Per-task engine activity from the daemon's `engine-state` channel
   * (event-driven, via engine hooks), keyed by taskId. The PRIMARY liveness
   * signal: `running` animates the spinner + "working" chip; `rate_limited` /
   * `permission_needed` / `error` show a distinct status chip. Optional — when
   * absent (or a task has no entry) the row falls back to the chatRunState /
   * `task.status` heuristics, so the polling turn-detector still covers it.
   */
  engineState?: Accessor<ReadonlyMap<string, TaskEngineState>>
  /**
   * Long daemon operations in flight, keyed by taskId, from the daemon's
   * `task.jobs` channel (today: `ensureWorktree` — a minutes-long
   * `git worktree add` on a huge repo). A row with an entry shows the
   * spinner + a "materializing" subtitle — in EVERY attached Tasks pane,
   * not just the one that initiated the blocking RPC. Optional like
   * {@link engineState}; absent means no job feedback (e.g. no daemon).
   */
  taskJobs?: Accessor<ReadonlyMap<string, TaskJobState>>
  /**
   * Daemon-collected `+N −M` counts keyed by worktree path, from the
   * `worktree.changes` channel (issue #6). When this yields a non-null
   * map, the per-row chips render the PUSHED counts and this process
   * spawns ZERO git subprocesses — the daemon is the single collector.
   * `null` / omitted (no daemon, an old daemon without the channel, or
   * the socket dropped) falls back to the local async poller, row by
   * row, with the original archived-row gate intact.
   */
  worktreeChanges?: Accessor<ReadonlyMap<string, WorktreeChanges> | null>
}

/**
 * View ids for the view switcher. Order matches the `SidebarView` union;
 * the `[` / `]` keys cycle within this list (currently 2 entries).
 * Labels are resolved via `t()` at the render site so they stay reactive.
 */
const VIEW_TABS: ReadonlyArray<{ view: SidebarView }> = [{ view: "active" }, { view: "archived" }]

/** Returns the localised tab label for a given view id. */
function viewTabLabel(view: SidebarView): string {
  switch (view) {
    case "active":
      return t("tasks.view.workspace")
    case "archived":
      return t("tasks.view.archives")
  }
}

/**
 * Polling interval (ms) for the per-main-row git branch refresh. The
 * sidebar caches each main row's branch name behind a `createMemo`
 * keyed on this tick + the repo path; advancing the tick busts the
 * memo and re-shells `git symbolic-ref` once per row. 2s is a
 * compromise — fast enough that the user doesn't notice a stale label
 * after a manual checkout, slow enough that the sidebar isn't a git
 * call generator on every redraw frame. Exported for tests.
 */
export const MAIN_BRANCH_POLL_MS = 2_000

/**
 * Max width (cells) for a task row's branch label. The rail is narrow, so
 * a long branch is truncated keeping its PREFIX (`feat/long-branch…`) —
 * the front of a branch name carries the type/scope the eye scans for,
 * the tail is usually a redundant slug. Exported for tests.
 */
export const BRANCH_LABEL_MAX = 16

/** Truncate keeping the prefix, with a trailing ellipsis when clipped. */
export function truncateBranchLabel(branch: string, max = BRANCH_LABEL_MAX): string {
  return truncateEnd(branch, max)
}

/**
 * Rough display width in terminal cells, counting CJK / fullwidth codepoints
 * as 2. Not Unicode-exact (no combining-mark or emoji-ZWJ handling) — just
 * enough to size the hover tooltip so a Chinese task title isn't clipped. A
 * slight over-estimate only widens the box, which is harmless.
 */
export function approxCellWidth(s: string): number {
  let n = 0
  for (const ch of s) n += (ch.codePointAt(0) ?? 0) >= 0x1100 ? 2 : 1
  return n
}

/** Truncate a filesystem path keeping the TAIL (the leaf carries the meaning). */
const truncatePathTail = truncateStart

export function Sidebar(props: SidebarProps) {
  const { theme } = useTheme()

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
      if (evt.defaultPrevented) return
      if (!focusedAccessor()) return
      if (evt.ctrl || evt.meta || evt.option) return
      if (evt.name === "backspace") {
        setSearchQuery((q) => q.slice(0, -1))
        return
      }
      // Printable single chars only — opentui's KeyEvent.sequence
      // holds the raw byte that arrived; non-printables (esc, arrows,
      // function keys) have multi-byte sequences or names like
      // "escape" / "return" / "up" that we already handle through
      // Block C bindings.
      const seq = evt.sequence
      if (!seq || seq.length !== 1) return
      const code = seq.charCodeAt(0)
      if (code < 32 || code === 127) return
      setSearchQuery((q) => q + seq)
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
    return `${count} ${count === 1 ? t("tasks.project.taskSingular") : t("tasks.project.taskPlural")}`
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
  // Line 1: container pad (4) + accent edge (1) + badge + its gap (2) +
  // scrollbar (1) + right pad (1) = 9 reserved.
  const titleBudget = createMemo(() => Math.max(6, effectiveWidth() - 9))
  // Line 2: the above plus the badge-column indent (2) and a reserve for the
  // right-aligned `+N −M` chip (~6) ≈ 16 reserved.
  const subtitleBudget = createMemo(() => Math.max(6, effectiveWidth() - 16))

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
  const projectScrollMaxHeight = createMemo(() => {
    const cellCap = Math.max(2, Math.min(10, Math.floor(dims().height * 0.25)))
    const contentHeight = Math.max(2, projectRows().length * 2)
    return Math.min(cellCap, contentHeight)
  })
  const [hover, setHover] = createSignal<{ task: Task; x: number; y: number } | null>(null)

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
    const cur = view()
    const idx = VIEW_TABS.findIndex((t) => t.view === cur)
    if (idx < 0) return
    const next = (idx + delta + VIEW_TABS.length) % VIEW_TABS.length
    const target = VIEW_TABS[next]
    if (target) setView(target.view)
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

  // Small section header — a BOLD CAPS label + a trailing dim rule that
  // fills the row (agent-deck pane-header grammar). Splits the PROJECTS
  // section from the TASKS section. `topPad` adds a blank line above so the
  // TASKS header lifts off the tight project list; the PROJECTS header sits
  // flush under the view tabs.
  const SectionHeader = (p: { label: string; suffix?: string; topPad?: boolean }) => (
    <box flexDirection="column" flexShrink={0}>
      <Show when={p.topPad}>
        <box flexShrink={0}>
          <text wrapMode="none"> </text>
        </box>
      </Show>
      <box flexDirection="row" flexShrink={0} gap={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
          {p.label}
        </text>
        {/* Ruler fills whatever the row leaves over: flexBasis 0 keeps its
            240-char content out of layout (it would crush the siblings),
            flexGrow takes the leftover, overflow clips. No width math —
            correct in the 32-cell native rail and a full tmux pane alike. */}
        <text fg={theme.border} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
          {"─".repeat(240)}
        </text>
        <Show when={p.suffix}>
          <text fg={theme.info} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
            {p.suffix}
          </text>
        </Show>
      </box>
    </box>
  )

  const toneColor = (tone: SidebarTone) => {
    switch (tone) {
      case "success":
        return theme.success
      case "warning":
        return theme.warning
      case "primary":
        return theme.primary
      case "error":
        return theme.error
      default:
        return theme.textMuted
    }
  }

  const ProjectRowCard = (p: { row: SidebarRow }) => {
    const task = p.row.task
    const flatIndex = p.row.flatIndex
    const isCursor = () => flatIndex === cursorIndex()
    const isSelected = () => task.id === props.selectedId()
    const isLive = createMemo(() => {
      const map = props.chatRunState?.()
      if (!map) return false
      const prefix = `${task.id}:`
      for (const [key, state] of map) {
        if (state === "running" && key.startsWith(prefix)) return true
      }
      return false
    })
    const changes = createMemo(
      () => {
        const pushed = pickPushedChanges(props.worktreeChanges?.(), task.worktreePath)
        if (pushed) return pushed
        branchTick()
        if (!task.archived) pollWorktreeChanges(task.worktreePath)
        return worktreeChanges(task.worktreePath)
      },
      undefined,
      { equals: sameWorktreeChanges },
    )
    const projectBranch = createMemo(() => {
      branchTick()
      pollCurrentBranch(task.repo)
      return currentBranch(task.repo)
    })
    const baseRowView = createMemo(() =>
      buildSidebarRowView({
        task,
        activity: props.engineState?.().get(task.id),
        job: props.taskJobs?.().get(task.id),
        live: isLive(),
        spinnerFrame: 0,
        subtitleBudget: subtitleBudget(),
        truncateBranch: truncateBranchLabel,
        mainBranch: projectBranch(),
      }),
    )
    const rowView = createMemo(() => withSpinnerFrame(baseRowView(), spinnerFrame))
    const stateColor = () => (!rowView().loading ? theme.primary : toneColor(rowView().tone))
    const barColor = () => (isCursor() ? theme.focusAccent : isSelected() ? theme.primary : undefined)
    const barGlyph = () => (isCursor() || isSelected() ? "▌" : " ")

    return (
      <box flexDirection="column" gap={0} paddingBottom={0}>
        {/* biome-ignore lint/a11y/useKeyWithMouseEvents: opentui terminal UI has no DOM focus model — hover here is a pointer-only affordance backed by keyboard nav (j/k + the detail always reachable by selecting the row), so onFocus/onBlur don't apply. */}
        <box
          ref={(r: BoxRenderable) => {
            rowEls.set(flatIndex, r)
            onCleanup(() => {
              if (rowEls.get(flatIndex) === r) rowEls.delete(flatIndex)
            })
          }}
          flexDirection="column"
          gap={0}
          backgroundColor={isCursor() ? theme.backgroundElement : undefined}
          onMouseUp={() => {
            // A click moves the cursor (the visual "selected pointer") to the
            // clicked row directly — it must not depend on onSelect, which a
            // task-bound pane no-ops to pin its highlight. Without this, after
            // j/k navigates away, clicking a row (even the pane's own task)
            // couldn't bring the pointer back.
            setCursorIndex(flatIndex)
            props.onSelect(task.id)
            if (props.activateOnClick) activateRow(task.id)
          }}
          onMouseOver={(e) => setHover({ task, x: e.x, y: e.y })}
          onMouseOut={() => setHover((h) => (h?.task.id === task.id ? null : h))}
        >
          <box flexDirection="row" gap={0}>
            <text fg={barColor()} wrapMode="none">
              {barGlyph()}
            </text>
            <box flexDirection="row" flexGrow={1} paddingRight={1} gap={0}>
              <text fg={stateColor()} attributes={TextAttributes.BOLD} wrapMode="none">
                {rowView().projectGlyph}
              </text>
              <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
                {spacedTitle(rowView().titleText, titleBudget())}
              </text>
            </box>
          </box>
          <box flexDirection="row" gap={0}>
            <text fg={barColor()} wrapMode="none">
              {barGlyph()}
            </text>
            <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none" flexGrow={1}>
                {rowView().subtitleText}
              </text>
              <Show when={changes().added > 0}>
                <text fg={theme.success} wrapMode="none">
                  +{changes().added}
                </text>
              </Show>
              <Show when={changes().deleted > 0}>
                <text fg={theme.error} wrapMode="none">
                  −{changes().deleted}
                </text>
              </Show>
            </box>
          </box>
        </box>
      </box>
    )
  }

  return (
    <box
      // width + flexShrink are applied together via `outerBoxRef` below, NOT as
      // props here. This is load-bearing and was the whole reason the task list
      // wouldn't scroll: opentui's `width` setter force-zeroes flexShrink (it
      // assumes an explicitly-sized box shouldn't flex). With flexShrink=0 this
      // rail refuses to shrink to its height-bounded host parent and sizes to
      // its FULL content height; the inner scrollbox inherits that height, so
      // opentui sees no overflow and the list never scrolls — j/k just walks
      // the cursor off the bottom edge. Setting width then restoring
      // flexShrink={1} in one effect (so order is guaranteed) re-bounds the box
      // to the pane, which lets the scrollbox clip + the viewport-follow effect
      // scroll. FileTree's outer box has no explicit width, so it kept the
      // shrink default and never hit this.
      ref={(r: BoxRenderable) => {
        outerBoxRef = r
      }}
      flexGrow={1}
      minHeight={0}
      flexDirection="column"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={0}
      paddingRight={0}
    >
      {/* Brand header: `kobe` on the left (focus-aware — focusAccent when
          this pane has focus, dimmed when not), with the version / update
          chip right-aligned (moved up from the footer's old `── system ──`
          block). paddingLeft={1} clears the 1-cell selection gutter (the ▌
          accent edge on each row) so the brand lines up with the row badge
          column. The root box has no horizontal padding — the pane sits
          flush to its tmux edges; this 1 cell is the kobe selection gutter,
          not padding. */}
      {/* Brand header: a left cluster (KOBE + the version/update chip hugging
          the name) and a clickable `[+]` new-task button pushed to the far
          right (justify space-between). */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" gap={1}>
          <text
            fg={focusedAccessor() ? theme.focusAccent : theme.textMuted}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
          >
            KOBE
          </text>
          <Show when={props.headerStatus?.()}>
            {(status) => (
              <text
                fg={status().emphasize ? theme.warning : theme.textMuted}
                attributes={status().emphasize ? TextAttributes.BOLD : TextAttributes.DIM}
                wrapMode="none"
                onMouseUp={() => props.onHeaderStatusClick?.()}
              >
                {status().label}
              </text>
            )}
          </Show>
        </box>
        <Show when={props.onAddTask}>
          <text
            fg={theme.primary}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
            onMouseUp={() => props.onAddTask?.()}
          >
            [+]
          </text>
        </Show>
      </box>

      {/* Inline `/`-search input. Only rendered while searchMode is on
         (entered via `/`); de-rendering on exit keeps the row count
         stable for users not using search. The input is auto-focused
         so the user can start typing immediately; up/down/enter/esc
         are handled by the sidebar-scope search bindings in keys.ts,
         not by the input itself. */}
      {/* Inline `/`-search row. Rendered as plain text rather than
         an opentui `<input>` element so the typed query is fully
         controlled by our `searchQuery` signal — see the
         createEffect above that captures keystrokes from the global
         keypress event. Avoids the focus/value-prop quirks of
         InputRenderable in a conditionally-mounted slot. */}
      <Show when={searchMode()}>
        <box flexDirection="row" gap={0} paddingBottom={1} paddingLeft={1}>
          <text fg={theme.info} wrapMode="none">
            /
          </text>
          <text fg={theme.text} wrapMode="none">
            {searchQuery()}
          </text>
          <text fg={theme.info} attributes={TextAttributes.BLINK} wrapMode="none">
            █
          </text>
          <Show when={searchQuery().length === 0}>
            <text fg={theme.textMuted} wrapMode="none">
              {" "}
              {t("tasks.search.placeholder")}
            </text>
          </Show>
          <Show when={searchQuery().length > 0}>
            <text fg={theme.textMuted} wrapMode="none">
              {" "}
              {flatIds().length}/{totalRows()}
            </text>
          </Show>
        </box>
      </Show>

      {/* View switcher + sort toggle. `[` / `]` toggles the view; `t`
          cycles default/manual order vs recent-use order. Non-default
          sort state is shown on the TASKS section header. */}
      <box
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <box flexDirection="row" gap={2}>
          <For each={VIEW_TABS}>
            {(tab) => {
              const active = () => view() === tab.view
              return (
                <text
                  fg={active() ? theme.primary : theme.textMuted}
                  attributes={active() ? TextAttributes.BOLD : undefined}
                  wrapMode="none"
                  onMouseUp={() => setView(tab.view)}
                >
                  {viewTabLabel(tab.view)}
                </text>
              )
            }}
          </For>
          {/* Subtle chord hint so new users discover `[`/`]` switches the
              view without hunting the footer legend. Quiet (muted + DIM),
              non-interactive — it doesn't alter tab layout or clicks. */}
          <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
            [/]
          </text>
        </box>
        <Show when={props.sortMode}>
          <text
            fg={theme.textMuted}
            attributes={TextAttributes.DIM}
            wrapMode="none"
            onMouseUp={() => props.onSortModeToggle?.()}
          >
            {t("tasks.sort")}
          </text>
        </Show>
      </box>

      {/* Body: split PROJECTS and TASKS into independent scroll regions.
         The flat cursor list is unchanged, but task overflow no longer pushes
         the project switcher/rows out of the rail. */}
      <Show when={projectRows().length > 0}>
        <box flexDirection="column" flexShrink={0}>
          {/* PROJECTS header doubles as the project filter: clicking cycles the
             active filter; the current filter label + matching task count ride
             on the same row instead of a separate line above. */}
          <box
            flexDirection="row"
            flexShrink={0}
            gap={1}
            paddingLeft={1}
            paddingRight={1}
            onMouseUp={() => cycleProjectFilter()}
          >
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
              {t("tasks.header.projects")}
            </text>
            <Show when={projectOptions().length > 1}>
              <text
                fg={projectFilterRepo() ? theme.primary : theme.textMuted}
                attributes={projectFilterRepo() ? TextAttributes.BOLD : undefined}
                wrapMode="none"
                flexShrink={0}
              >
                {projectFilterLabel()}
              </text>
            </Show>
            {/* Same flex ruler as SectionHeader — flexBasis 0 + grow + clip. */}
            <text fg={theme.border} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
              {"─".repeat(240)}
            </text>
            <Show when={projectOptions().length > 1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none" flexShrink={0}>
                {projectFilterCountLabel()}
              </text>
            </Show>
          </box>
          <scrollbox
            ref={(r: ScrollBoxRenderable) => {
              projectScrollRef = r
            }}
            flexShrink={0}
            flexGrow={0}
            minHeight={0}
            maxHeight={projectScrollMaxHeight()}
            stickyScroll={false}
            verticalScrollbarOptions={{
              trackOptions: {
                foregroundColor: "transparent",
              },
            }}
          >
            <box flexShrink={0} gap={0} paddingRight={1}>
              <For each={projectRows()}>{(row) => <ProjectRowCard row={row} />}</For>
            </box>
          </scrollbox>
        </box>
      </Show>

      <SectionHeader
        label={t("tasks.header.tasks")}
        suffix={sortMode() === "default" ? undefined : sortMode()}
        topPad={projectRows().length > 0}
      />
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          taskScrollRef = r
        }}
        flexGrow={1}
        minHeight={0}
        stickyScroll={false}
        verticalScrollbarOptions={{
          trackOptions: {
            foregroundColor: "transparent",
          },
        }}
      >
        {/* gap={0} — TASK cards each carry a trailing blank line so they read
            as separate cards. PROJECT rows live in their own scroll region. */}
        <box flexShrink={0} gap={0} paddingRight={1}>
          <For each={taskRows()}>
            {(row) => {
              const task = row.task
              const flatIndex = row.flatIndex
              const isCursor = () => flatIndex === cursorIndex()
              const isSelected = () => task.id === props.selectedId()
              // "Is this task actually streaming a turn right now?"
              // True when the orchestrator holds a live engine handle for
              // ANY of this task's tabs — covers multi-tab tasks where the
              // running tab is not the active one. Spinner fires on isLive,
              // not on task.status, so it stops immediately on interrupt
              // (the handle drops) without waiting for the lifecycle to settle.
              const isLive = createMemo(() => {
                const map = props.chatRunState?.()
                if (!map) return false
                const prefix = `${task.id}:`
                for (const [key, state] of map) {
                  if (state === "running" && key.startsWith(prefix)) return true
                }
                return false
              })
              // Per-row "uncommitted changes" file counts, rendered on
              // the right edge as `+N −M`. PREFERRED source: the daemon's
              // `worktree.changes` pushes (issue #6) — one collector in
              // the daemon, zero git subprocesses in this pane. FALLBACK
              // (no daemon / old daemon / socket down): the local ASYNC
              // poller — the `branchTick` read keeps the ~2s cadence, and
              // a huge worktree costs a background child process, never a
              // frozen event loop (a 30GB repo's sync `git status` used
              // to hard-freeze the pane the moment its row rendered).
              // Archived rows show nothing and trigger nothing on either
              // path: the daemon never collects them, and the local path
              // keeps its poll gate — the Archives view must not pay
              // git-status for shelved worktrees (the original bug).
              // The memo's custom `equals` keeps §5.5 intact on the push
              // path: each push is a fresh map reference, so the memo
              // recomputes, but unchanged counts don't propagate to the
              // row. Empty when the worktree is clean — the renderer
              // skips the chip entirely. Returned as a struct (not a
              // joined string) so the renderer can colour `+N` with
              // `theme.success` and `−N` with `theme.error`, matching
              // the FileTree pane's per-file `+/−` badges.
              const changes = createMemo(
                () => {
                  const pushed = pickPushedChanges(props.worktreeChanges?.(), task.worktreePath)
                  if (pushed) return pushed
                  branchTick()
                  if (!task.archived) pollWorktreeChanges(task.worktreePath)
                  return worktreeChanges(task.worktreePath)
                },
                undefined,
                { equals: sameWorktreeChanges },
              )
              // Two-stage view derivation (waste audit). Stage 1 builds
              // everything EXCEPT the animated glyph with a fixed frame —
              // it deliberately does NOT read `spinnerFrame`, so the 10Hz
              // tick re-derives nothing here. Stage 2 overlays the live
              // frame via `withSpinnerFrame`, which reads the frame
              // accessor only when the row is loading — Solid re-collects
              // memo deps per run, so an idle row's memo simply isn't
              // subscribed to the tick. Before this split every row
              // rebuilt its full view 10×/s even with nothing running
              // (N rows × 10Hz string/object churn); now an idle sidebar
              // does zero per-tick work.
              const baseRowView = createMemo(() =>
                buildSidebarRowView({
                  task,
                  activity: props.engineState?.().get(task.id),
                  job: props.taskJobs?.().get(task.id),
                  live: isLive(),
                  spinnerFrame: 0,
                  subtitleBudget: subtitleBudget(),
                  truncateBranch: truncateBranchLabel,
                  mainBranch: "",
                }),
              )
              const rowView = createMemo(() => withSpinnerFrame(baseRowView(), spinnerFrame))
              const stateColor = () => toneColor(rowView().tone)
              // Accent edge: focus-accent ▌ on the cursor row, a quieter
              // (dimmed primary) ▌ on the active row when the two differ after
              // j/k nav, a bare space otherwise to hold the gutter.
              const barColor = () => (isCursor() ? theme.focusAccent : isSelected() ? theme.primary : undefined)
              const barGlyph = () => (isCursor() || isSelected() ? "▌" : " ")
              return (
                <box flexDirection="column" gap={0} paddingBottom={1}>
                  {/* Interactive row body. The cursor row carries a SUBTLE
                      `backgroundElement` tint (a quiet block, not the old
                      solid-terracotta full fill) so badges / branch / `+N −M`
                      keep their semantic colours instead of being flattened to
                      inverted text — warp/agent-deck selection grammar: a left
                      accent ▌ carries focus, the fill stays quiet.
                      `backgroundElement` survives transparent mode (theme.tsx
                      keeps it tinted) and the bar is foreground paint, so the
                      row reads even when the fill is suppressed. */}
                  {/* biome-ignore lint/a11y/useKeyWithMouseEvents: opentui terminal UI has no DOM focus model — hover here is a pointer-only affordance backed by keyboard nav (j/k + the detail always reachable by selecting the row), so onFocus/onBlur don't apply. */}
                  <box
                    ref={(r: BoxRenderable) => {
                      rowEls.set(flatIndex, r)
                      onCleanup(() => {
                        if (rowEls.get(flatIndex) === r) rowEls.delete(flatIndex)
                      })
                    }}
                    flexDirection="column"
                    gap={0}
                    backgroundColor={isCursor() ? theme.backgroundElement : undefined}
                    onMouseUp={() => {
                      // Click moves the cursor directly (see the project-row
                      // handler above) — decoupled from onSelect so it works in
                      // a task-bound pane that no-ops onSelect to pin its row.
                      setCursorIndex(flatIndex)
                      props.onSelect(task.id)
                      if (props.activateOnClick) activateRow(task.id)
                    }}
                    onMouseOver={(e) => setHover({ task, x: e.x, y: e.y })}
                    onMouseOut={() => setHover((h) => (h?.task.id === task.id ? null : h))}
                  >
                    {/* TASK row (a worktree) — two-line card. */}
                    {/* Line 1: accent edge + status badge + title + a
                        "working" chip while the engine is streaming. */}
                    <box flexDirection="row" gap={0}>
                      <text fg={barColor()} wrapMode="none">
                        {barGlyph()}
                      </text>
                      <box flexDirection="row" flexGrow={1} paddingRight={1} gap={0}>
                        <text fg={stateColor()} attributes={TextAttributes.BOLD} wrapMode="none">
                          {rowView().stateGlyph}
                        </text>
                        <text
                          fg={theme.text}
                          attributes={isSelected() || isCursor() ? TextAttributes.BOLD : undefined}
                          wrapMode="none"
                          flexGrow={1}
                        >
                          {spacedTitle(rowView().titleText, titleBudget())}
                        </text>
                        <Show when={props.moveMode?.() && isCursor()}>
                          <text fg={theme.warning} wrapMode="none">
                            {t("tasks.moveChip")}
                          </text>
                        </Show>
                      </box>
                    </box>
                    {/* Line 2: accent edge (continues the bar) + subtitle,
                        indented under the title. Branch (or status word) on
                        the left, the `+N −M` change chip pushed to the right. */}
                    <box flexDirection="row" gap={0}>
                      <text fg={barColor()} wrapMode="none">
                        {barGlyph()}
                      </text>
                      <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
                        <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none" flexGrow={1}>
                          {rowView().subtitleText}
                        </text>
                        <Show when={task.pinned === true}>
                          <text fg={theme.warning} wrapMode="none">
                            ▴
                          </text>
                        </Show>
                        <Show when={prCheckChip(task)}>
                          {(chip) => (
                            <text fg={toneColor(chip().tone)} wrapMode="none">
                              {chip().glyph}
                            </text>
                          )}
                        </Show>
                        <Show when={changes().added > 0}>
                          <text fg={theme.success} wrapMode="none">
                            +{changes().added}
                          </text>
                        </Show>
                        <Show when={changes().deleted > 0}>
                          <text fg={theme.error} wrapMode="none">
                            −{changes().deleted}
                          </text>
                        </Show>
                      </box>
                    </box>
                  </box>
                </box>
              )
            }}
          </For>
          <Show when={flatIds().length === 0}>
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted}>
                {searchMode() && searchQuery().trim().length > 0
                  ? t("tasks.empty.noMatchSearch")
                  : projectFilterRepo()
                    ? view() === "active"
                      ? t("tasks.empty.noActiveProject")
                      : t("tasks.empty.noArchivedProject")
                    : view() === "active"
                      ? t("tasks.empty.noActive")
                      : t("tasks.empty.noArchived")}
              </text>
            </box>
          </Show>
          <Show
            when={
              projectFilterRepo() &&
              flatIds().length > 0 &&
              !hasTaskRows() &&
              !(searchMode() && searchQuery().trim().length > 0)
            }
          >
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                {view() === "active" ? t("tasks.empty.noActiveProject") : t("tasks.empty.noArchivedProject")}
              </text>
            </box>
          </Show>
          {/* Non-empty Archives: remind the user `a` returns a row to Working.
              Only shown when there's actually a row to act on. */}
          <Show when={view() === "archived" && flatIds().length > 0}>
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                {t("tasks.archiveHint")}
              </text>
            </box>
          </Show>
        </box>
      </scrollbox>

      {/* Zen-mode indicator, pinned to the rail's bottom-left. The scrollbox
          above takes flexGrow={1}, so this row sits flush at the bottom. Only
          rendered while the ChatTab is collapsed to the engine pane — a quiet
          reminder that `prefix`+space (or the `zen` chip) toggles it back. */}
      <Show when={props.zenActive?.()}>
        <box flexShrink={0} paddingLeft={1} paddingRight={1} paddingTop={1}>
          <text
            fg={theme.accent}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
            onMouseUp={() => props.onZenClick?.()}
          >
            ☯ ZEN
          </text>
        </box>
      </Show>

      {/* Hover tooltip overlay. Absolute + high zIndex so it floats above the
          rows; anchored just below-right of the cursor and clamped inside the
          screen. `backgroundElement` stays opaque even in transparent mode, so
          the detail stays readable over whatever is behind it. The full title,
          branch, and worktree path live here — the place to look when the
          narrow-rail row had to drop them. */}
      <Show when={hover()}>
        {(h) => {
          const lines = createMemo(() => {
            const t = h().task
            const out: { text: string; bold?: boolean; dim?: boolean }[] = []
            out.push({ text: t.kind === "main" ? repoBasename(t.repo) : t.title, bold: true })
            if (t.branch.length > 0) out.push({ text: `⎇ ${t.branch}` })
            if (t.worktreePath.length > 0) out.push({ text: t.worktreePath, dim: true })
            return out
          })
          // Width = widest line (CJK-aware) capped, + padding (2) + border (2).
          const TOOLTIP_MAX_W = 72
          const innerW = createMemo(() =>
            Math.min(TOOLTIP_MAX_W - 4, Math.max(...lines().map((l) => approxCellWidth(l.text)))),
          )
          const boxW = createMemo(() => innerW() + 4)
          const boxH = createMemo(() => lines().length + 2) // content rows + top/bottom border
          const left = createMemo(() => Math.max(0, Math.min(h().x + 2, dims().width - boxW() - 1)))
          const top = createMemo(() => Math.max(0, Math.min(h().y + 1, dims().height - boxH() - 1)))
          return (
            <box
              position="absolute"
              zIndex={2600}
              left={left()}
              top={top()}
              width={boxW()}
              flexDirection="column"
              border
              borderColor={theme.focusAccent}
              backgroundColor={theme.backgroundElement}
              paddingLeft={1}
              paddingRight={1}
            >
              <For each={lines()}>
                {(l) => (
                  <text
                    fg={l.dim ? theme.textMuted : theme.text}
                    attributes={l.bold ? TextAttributes.BOLD : l.dim ? TextAttributes.DIM : undefined}
                    wrapMode="none"
                  >
                    {l.dim ? truncatePathTail(l.text, innerW()) : truncateTitle(l.text, innerW())}
                  </text>
                )}
              </For>
            </box>
          )
        }}
      </Show>
    </box>
  )
}
