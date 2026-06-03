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
 *   │ ★ kobe                      ~/i/kobe    │
 *   │ ★ pochi                     ~/i/pochi   │
 *   │                                        │
 *   │ TASKS ─────────────────────────────    │
 *   │ ▌⠹ fix login redirect bug    working   │
 *   │ ▌  feat/login-fix            +12 −3     │
 *   │                                        │
 *   │   ○ add password reset                 │
 *   │     backlog                            │
 *   │                                        │
 *   │ + New task                              │
 *   └───────────────────────────────────────┘
 *
 * Each section gets a small BOLD CAPS header + trailing rule. A PROJECT
 * row is a compact single line: ★ + repo name, with the repo
 * dir (home-abbreviated) on the right — or an animated `working` chip
 * while that repo-root session is live. A TASK row is a small two-line
 * card: line 1 = status badge + title + a `working` chip while the
 * engine streams; line 2 = the branch (or a status word when the task
 * has no branch yet) + the `+N −M` uncommitted-change chip. Tasks carry
 * a trailing blank line so each reads as its own card; projects sit
 * tight. The cursor row gets a left accent ▌ and a subtle background
 * tint; the active row keeps a dimmer ▌ when the cursor moves off it.
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

import type { Task, TaskStatus } from "@/types/task"
import type { KeyEvent } from "@opentui/core"
import { TextAttributes } from "@opentui/core"
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
import { type SidebarView, buildRows, flattenIds, repoBasename } from "./groups"
import { useSidebarBindings } from "./keys"
import { readWorktreeChanges } from "./worktree-changes"

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
  /**
   * Optional callback for the `+ New task` footer affordance. Left
   * undefined this stream; the global `n`/`ctrl+n` bindings remain the
   * canonical entry point.
   */
  onAddTask?: () => void
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
   * Optional width override. When omitted, falls back to {@link SIDEBAR_WIDTH}.
   * Wired by the Shell so the sidebar↔workspace splitter can resize the pane
   * at runtime. Reactive — changing the accessor's value reflows immediately.
   */
  width?: Accessor<number>
  /**
   * Optional right-aligned status in the `kobe` brand header — the Tasks pane
   * wires the version / "update available" chip here (it moved up from the
   * footer's old `── system ──` block). `emphasize: true` paints it in the
   * warning colour (an update is waiting); omit / return `null` to hide it.
   */
  headerStatus?: Accessor<{ label: string; emphasize: boolean } | null>
  /** Click handler for {@link headerStatus} — e.g. open the update page. */
  onHeaderStatusClick?: () => void
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
}

/**
 * Glyph + theme-token name for each status's badge. We render the glyph
 * with the theme colour resolved at render time; storing the *tone* (not
 * the resolved RGBA) keeps badges reactive to theme switches.
 *
 * Each status now uses a *distinct* glyph so the row is readable without
 * relying on colour alone — teammate feedback was that the old
 * dot-on-dot-on-half-dot set wasn't legible. `in_progress` is special:
 * its glyph is the empty string here and the renderer substitutes the
 * current frame of {@link IN_PROGRESS_SPINNER} (rotating braille) so an
 * active task visibly *moves*.
 *
 * Per-task hint only — no grouping reads from this map.
 */
const STATUS_BADGE: Record<
  TaskStatus,
  { glyph: string; tone: "success" | "warning" | "primary" | "textMuted" | "error" }
> = {
  done: { glyph: "✓", tone: "success" },
  in_review: { glyph: "◐", tone: "warning" },
  in_progress: { glyph: "", tone: "primary" },
  backlog: { glyph: "○", tone: "textMuted" },
  canceled: { glyph: "⊘", tone: "textMuted" },
  error: { glyph: "✕", tone: "error" },
}

/**
 * Human-readable status words for a card's second (metadata) line, shown
 * only when the task has no branch yet to put there — so a backlog task
 * reads `backlog` rather than a blank subtitle, keeping every card a
 * consistent two lines tall.
 */
const STATUS_LABEL: Record<TaskStatus, string> = {
  done: "done",
  in_review: "in review",
  in_progress: "working",
  backlog: "backlog",
  canceled: "canceled",
  error: "error",
}

/**
 * Braille spinner frames for the `in_progress` row badge. Standard
 * dots-rotating cycle (the same one npm / yarn / most CLI loaders use),
 * picked because it reads as motion in a *single cell* — drop-in for the
 * one-cell badge slot. Sub-pixel-style rotation makes "active" obvious
 * without enlarging the row.
 */
const IN_PROGRESS_SPINNER: readonly string[] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

/** Spinner tick (ms). 100ms matches the standard CLI loader cadence. */
const SPINNER_FRAME_MS = 100

/**
 * Tab labels for the view switcher. Order matches the `SidebarView`
 * union; the `[` / `]` keys cycle within this list (currently 2 entries).
 */
const VIEW_TABS: ReadonlyArray<{ view: SidebarView; label: string }> = [
  { view: "active", label: "Working session" },
  { view: "archived", label: "Archives" },
]

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
 * Reserved width (cells) for the per-row "uncommitted changes" chip
 * (`+N −M`). Sized to fit the common `+9 −9` (5 cell) case exactly;
 * the chip is right-aligned inside the column so longer chips (e.g.
 * `+12 −3`, 6 char) extend slightly leftward toward the title rather
 * than cluttering the row's right edge with reserved padding. Even
 * longer chips (`+99 −99`, 7 char) clip on the left — rare in practice
 * and the right edge stays aligned, which is what the eye tracks.
 * Keeping the column reserved even when empty is the whole point of
 * this — the eye should land on the same x for every row's chip
 * regardless of how short or long the title above it is. Exported for
 * tests.
 */
export const CHANGES_COLUMN_WIDTH = 5

/**
 * Max width (cells) for a task row's branch label. The rail is narrow, so
 * a long branch is truncated keeping its PREFIX (`feat/long-branch…`) —
 * the front of a branch name carries the type/scope the eye scans for,
 * the tail is usually a redundant slug. Exported for tests.
 */
export const BRANCH_LABEL_MAX = 16

/** Truncate keeping the prefix, with a trailing ellipsis when clipped. */
export function truncateBranchLabel(branch: string, max = BRANCH_LABEL_MAX): string {
  if (branch.length <= max) return branch
  return `${branch.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Responsive column breakpoints (cells of total pane width). A task row packs
 * up to four columns — badge, title, the `+N −M` changes chip, and the branch
 * label. The branch (≤16 cells) + changes (5) are *metadata*; the title is the
 * primary content. On a narrow rail those metadata columns are `flexShrink={0}`
 * and would crush the title to a single character (`(new task)` → `(`), so we
 * drop them progressively as width shrinks: title-only first, then add the
 * changes chip, then the branch. The title always survives. Above the branch
 * breakpoint the full row shows. Tuned so the 32-cell convention width
 * ({@link SIDEBAR_WIDTH}) keeps the changes chip but hides the branch, leaving
 * a comfortable title budget; widen the pane and the branch returns.
 */
export const SHOW_CHANGES_MIN_WIDTH = 30
export const SHOW_BRANCH_MIN_WIDTH = 44

/**
 * Truncate a task title to a cell budget with a trailing ellipsis. Mirrors
 * {@link truncateBranchLabel} but keeps the prefix unconditionally (a title's
 * front carries the most meaning). Uses `.length` like the branch path — CJK
 * wide-char accounting is a known, accepted imprecision shared by both.
 */
export function truncateTitle(title: string, max: number): string {
  if (max <= 0) return ""
  if (title.length <= max) return title
  return `${title.slice(0, Math.max(0, max - 1))}…`
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
function truncatePathTail(path: string, max: number): string {
  if (max <= 0 || path.length <= max) return path
  return `…${path.slice(path.length - Math.max(0, max - 1))}`
}

/**
 * Abbreviate the user's home prefix to `~` for the project (main row)
 * directory label — `/Users/x/i/kobe` → `~/i/kobe`. Keeps the project
 * row's repo path compact and recognisable. Falls back to the raw path
 * when `$HOME` is unset or doesn't prefix the path.
 */
export function abbrevHome(path: string): string {
  const home = process.env.HOME
  if (home && (path === home || path.startsWith(`${home}/`))) {
    return `~${path.slice(home.length)}`
  }
  return path
}

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
  // only happens when a row is visible and re-renders. We deliberately
  // do NOT register onCleanup here — sidebar can be off-screen briefly
  // during pane focus changes and we still want branch labels to be
  // fresh when it comes back. The interval lives for the process lifetime
  // (kobe's app shell never unmounts the sidebar in normal use).
  const [branchTick, setBranchTick] = createSignal(0)
  void setInterval(() => setBranchTick((n) => n + 1), MAIN_BRANCH_POLL_MS)

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
  const rows = createMemo(() => buildRows(props.tasks(), view(), searchMode() ? searchQuery() : ""))
  const flatIds = createMemo(() => flattenIds(rows()))
  // The list is two sections: PROJECTS (the `main` repo-root rows, which
  // `buildRows` always emits first) then all TASKS (worktrees) flat — NOT
  // grouped per project (Jackson's call). `firstTaskFlatIndex` is the
  // flatIndex of the first non-main row; the renderer draws a divider above
  // it to split the two sections. -1 when there are no tasks (projects only),
  // and 0 when there are no projects (the divider then never renders).
  const firstTaskFlatIndex = createMemo(() => {
    const r = rows()
    const idx = r.findIndex((row) => row.task.kind !== "main")
    return idx < 0 ? -1 : r[idx]!.flatIndex
  })
  // Total unfiltered count for the active view — used to show "N/total" in search mode.
  const totalRows = createMemo(() => flattenIds(buildRows(props.tasks(), view(), "")).length)

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
  const [hover, setHover] = createSignal<{ task: Task; x: number; y: number } | null>(null)

  const [cursorIndex, setCursorIndex] = createSignal<number>(-1)

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
        if (id === null) {
          if (cur === -1 && ids.length > 0) setCursorIndex(0)
          else if (cur >= ids.length) setCursorIndex(Math.max(0, ids.length - 1))
          else if (ids.length === 0) setCursorIndex(-1)
          return
        }
        const idx = ids.indexOf(id)
        if (idx >= 0 && idx !== cur) setCursorIndex(idx)
      },
    ),
  )

  // Reset cursor to 0 on view switch — the previous index is meaningless
  // against the new filtered list. `on` so we react only to view
  // changes, not to upstream task churn.
  createEffect(
    on(view, () => {
      const ids = flatIds()
      setCursorIndex(ids.length > 0 ? 0 : -1)
    }),
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
      props.onActivate?.(id)
    },
    onDeleteRequest: (id) => props.onDeleteRequest?.(id),
    onArchiveRequest: (id) => props.onArchiveRequest?.(id),
    onLocalMergeRequest: (id) => props.onLocalMergeRequest?.(id),
    onRenameRequest: (id) => props.onRenameRequest?.(id),
    onPinRequest: (id) => props.onPinRequest?.(id),
    onViewSwitch: (delta) => cycleView(delta),
    searchMode,
    onSearchEnter: () => enterSearch(),
    onSearchExit: (select) => exitSearch(select),
  })

  // Small section header — a BOLD CAPS label + a trailing dim rule that
  // fills the row (agent-deck pane-header grammar). Splits the PROJECTS
  // section from the TASKS section. `topPad` adds a blank line above so the
  // TASKS header lifts off the tight project list; the PROJECTS header sits
  // flush under the view tabs.
  const SectionHeader = (p: { label: string; topPad?: boolean }) => (
    <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} paddingTop={p.topPad ? 1 : 0}>
      <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
        {p.label}
      </text>
      <text fg={theme.border} wrapMode="none">
        {"─".repeat(Math.max(2, effectiveWidth() - 9 - p.label.length))}
      </text>
    </box>
  )

  return (
    <box
      width={props.width ? props.width() : SIDEBAR_WIDTH}
      flexShrink={0}
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
      <box
        flexDirection="row"
        justifyContent="space-between"
        gap={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
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
              fuzzy filter
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

      {/* View switcher: tab strip with the active view emphasized by
          colour + bold, no brackets. `[` / `]` toggles. */}
      <box flexDirection="row" gap={2} paddingBottom={1} paddingLeft={1}>
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
                {tab.label}
              </text>
            )
          }}
        </For>
      </box>

      {/* Body: scrollable flat task list. Stretches with flexGrow so
         the footer always sits at the bottom. */}
      <scrollbox
        flexGrow={1}
        verticalScrollbarOptions={{
          trackOptions: {
            foregroundColor: "transparent",
          },
        }}
      >
        {/* gap={0} — spacing is per-row: PROJECT rows sit tight as a compact
            switcher up top, TASK cards each carry a trailing blank line so they
            read as separate cards, and a divider splits the two sections. */}
        <box flexShrink={0} gap={0} paddingRight={1}>
          <For each={rows()}>
            {(row) => {
              const task = row.task
              const flatIndex = row.flatIndex
              const isCursor = () => flatIndex === cursorIndex()
              const isSelected = () => task.id === props.selectedId()
              const isMain = task.kind === "main"
              const badge = STATUS_BADGE[task.status]
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
              const badgeColor = () => {
                if (isMain) return theme.primary
                // Any live tab → use primary (spinner) colour.
                if (isLive()) return theme.primary
                switch (badge.tone) {
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
              // Per-row "uncommitted changes" file counts, rendered on
              // the right edge as `+N −M`. Keyed on the same `branchTick`
              // so we only shell out at the established 2s cadence.
              // Empty when the worktree is clean — the renderer skips
              // the chip entirely. Returned as a struct (not a joined
              // string) so the renderer can colour `+N` with
              // `theme.success` and `−N` with `theme.error`, matching
              // the FileTree pane's per-file `+/−` badges.
              const changes = createMemo(() => {
                branchTick()
                return readWorktreeChanges(task.worktreePath)
              })
              const titleText = isMain ? repoBasename(task.repo) : task.title
              // Loading = the engine is actively working this task. Driven by
              // `task.status === "in_progress"` (the only liveness signal the
              // Tasks pane has — chatRunState is unwired there) OR a live
              // engine handle when the outer monitor does pass chatRunState.
              const loading = () => isLive() || task.status === "in_progress"
              // Task-card subtitle (line 2): the branch, or a human status word
              // when there's no branch yet, so every card stays two lines tall.
              const subtitleText = createMemo(() => {
                if (task.branch.length > 0) return truncateBranchLabel(task.branch, subtitleBudget())
                return STATUS_LABEL[task.status]
              })
              // Accent edge: focus-accent ▌ on the cursor row, a quieter
              // (dimmed primary) ▌ on the active row when the two differ after
              // j/k nav, a bare space otherwise to hold the gutter.
              const barColor = () => (isCursor() ? theme.focusAccent : isSelected() ? theme.primary : undefined)
              const barGlyph = () => (isCursor() || isSelected() ? "▌" : " ")
              // Section headers split the two flat sections (NOT per-project
              // grouping): PROJECTS above the first row when it's a project,
              // TASKS above the first non-main row. `topPad` lifts the TASKS
              // header off the tight project list only when projects exist.
              const showProjectsHeader = () => isMain && flatIndex === 0
              const showTasksHeader = () => !isMain && flatIndex === firstTaskFlatIndex()
              return (
                <box flexDirection="column" gap={0} paddingBottom={isMain ? 0 : 1}>
                  <Show when={showProjectsHeader()}>
                    <SectionHeader label="PROJECTS" />
                  </Show>
                  <Show when={showTasksHeader()}>
                    <SectionHeader label="TASKS" topPad={firstTaskFlatIndex() > 0} />
                  </Show>
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
                    flexDirection="column"
                    gap={0}
                    backgroundColor={isCursor() ? theme.backgroundElement : undefined}
                    onMouseUp={() => {
                      props.onSelect(task.id)
                      if (props.activateOnClick) props.onActivate?.(task.id)
                    }}
                    onMouseOver={(e) => setHover({ task, x: e.x, y: e.y })}
                    onMouseOut={() => setHover((h) => (h?.task.id === task.id ? null : h))}
                  >
                    {/* PROJECT row (a `main` repo-root) — a compact single line:
                        ★ + repo name, with the repo dir (or a "working" chip
                        while its session is live) on the right. */}
                    <Show when={isMain}>
                      <box flexDirection="row" gap={0}>
                        <text fg={barColor()} wrapMode="none">
                          {barGlyph()}
                        </text>
                        <box flexDirection="row" flexGrow={1} paddingRight={1} gap={1}>
                          <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
                            {loading() ? (IN_PROGRESS_SPINNER[spinnerFrame()] ?? IN_PROGRESS_SPINNER[0]) : "★"}
                          </text>
                          <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
                            {truncateTitle(titleText, titleBudget())}
                          </text>
                          <Show when={loading()}>
                            <text fg={theme.primary} wrapMode="none">
                              working
                            </text>
                          </Show>
                          <Show when={!loading()}>
                            <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
                              {truncatePathTail(abbrevHome(task.repo), subtitleBudget())}
                            </text>
                          </Show>
                        </box>
                      </box>
                    </Show>
                    {/* TASK row (a worktree) — two-line card. */}
                    <Show when={!isMain}>
                      {/* Line 1: accent edge + status badge + title + a
                          "working" chip while the engine is streaming. */}
                      <box flexDirection="row" gap={0}>
                        <text fg={barColor()} wrapMode="none">
                          {barGlyph()}
                        </text>
                        <box flexDirection="row" flexGrow={1} paddingRight={1} gap={1}>
                          <text fg={badgeColor()} attributes={TextAttributes.BOLD} wrapMode="none">
                            {loading() ? (IN_PROGRESS_SPINNER[spinnerFrame()] ?? IN_PROGRESS_SPINNER[0]) : badge.glyph}
                          </text>
                          <text
                            fg={theme.text}
                            attributes={isSelected() || isCursor() ? TextAttributes.BOLD : undefined}
                            wrapMode="none"
                            flexGrow={1}
                          >
                            {truncateTitle(titleText, titleBudget())}
                          </text>
                          <Show when={loading()}>
                            <text fg={theme.primary} wrapMode="none">
                              working
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
                            {subtitleText()}
                          </text>
                          <Show when={task.pinned === true}>
                            <text fg={theme.warning} wrapMode="none">
                              ▴
                            </text>
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
                    </Show>
                  </box>
                </box>
              )
            }}
          </For>
          <Show when={flatIds().length === 0}>
            <box paddingTop={1} paddingLeft={1}>
              <text fg={theme.textMuted}>
                {searchMode() && searchQuery().trim().length > 0
                  ? "No matching tasks — esc to clear."
                  : view() === "active"
                    ? "No active tasks."
                    : "No archived tasks."}
              </text>
            </box>
          </Show>
        </box>
      </scrollbox>

      {/* Footer: "+ New task" affordance. */}
      <box flexShrink={0} paddingTop={1} paddingLeft={1}>
        <text fg={theme.textMuted} wrapMode="none" onMouseUp={() => props.onAddTask?.()}>
          + New task
        </text>
      </box>

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
