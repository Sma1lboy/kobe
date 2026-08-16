/** @jsxImportSource @opentui/react */
/**
 * One-line tree rows (owner call 2026-08-01, round 3): every row inside the
 * tree is ONE cell tall, with progressive per-level indent — project header,
 * worktrees two cells in, tabs two more. The two-line cards remain the FLAT
 * sidebar's grammar; the tree's density is its point (a dozen worktrees ×
 * tabs must fit the rail), so a worktree row compresses the card to
 * `twisty · state glyph · title` plus the card's own right-edge cluster
 * (pin / PR chip / ±stats / jump digit) — same vocabulary, one line.
 */

import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import type { Task } from "@/types/task"
import { type BoxRenderable, MouseButton } from "@opentui/core"
import { type ReactNode, useEffect } from "react"
import { currentBranch, pollCurrentBranch } from "../../../tui/panes/sidebar/git-head"
import { NO_STATE_GLYPH, buildSidebarRowView, prCheckChip, withSpinnerFrame } from "../../../tui/panes/sidebar/row-view"
import { type TreeTab, tabRowActivity } from "../../../tui/panes/sidebar/tree-core"
import { toneColor, truncateBranchLabel } from "../../../tui/panes/sidebar/view-core"
import type { WorktreeChanges } from "../../../tui/panes/sidebar/worktree-changes"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { resolveRowSelectionChrome } from "../../ui/row-selection-chrome"
import {
  ChangeStats,
  JumpDigit,
  completionSeenFor,
  completionStampOf,
  useChanges,
  useDurableCompletionSeen,
  useSpinnerFrame,
} from "./row-cards"

/** Cells of indent per depth level — one (owner round: the rail is narrow,
 *  and the glyph column already separates the levels visually). */
const INDENT_CELLS = 1

export type TreeRowShared = {
  /** Cursor position in the tree's flat id list. */
  readonly cursorIndex: number
  /** The row id the right pane is showing (`taskId::tabId` when a tab). */
  readonly activeRowId: string | null
  /** The task whose session the right pane shows. The unread-lamp digest
   *  keys on THIS (selected task + the tab's own active bit) rather than on
   *  `activeRowId`: that id needs the live tab map, which is cold right
   *  after a restart — and a lamp that ignores the session you are sitting
   *  in is exactly the bug. */
  readonly selectedTaskId: string | null
  /** Keyed by FLAT INDEX so one scroll-follow lookup covers every row. */
  readonly rowEls: Map<number, BoxRenderable>
  readonly onPress: (flatIndex: number, rowId: string) => void
  /** Right-click. Absent = right-click falls through to a plain activate. */
  readonly onContextMenu?: (flatIndex: number, rowId: string, x: number, y: number) => void
  /** The sidebar's ~2s poll tick — drives the ±stats poller. */
  readonly branchTick: number
  readonly engineState?: ReadonlyMap<string, TaskEngineState>
  /** Per-tab activity (taskId → tabId → state) — the precise signal for a
   *  tab row; `engineState` is the task-level rollup fallback. */
  readonly engineTabState?: ReadonlyMap<string, ReadonlyMap<string, TaskEngineState>>
  readonly engineLifecycle?: ReadonlyMap<string, { readonly subagents: number }>
  readonly taskJobs?: ReadonlyMap<string, TaskJobState>
  readonly worktreeChanges?: ReadonlyMap<string, WorktreeChanges> | null
}

function RowShell(props: {
  readonly rowId: string
  readonly flatIndex: number
  readonly depth: number
  readonly shared: TreeRowShared
  readonly children: ReactNode
}) {
  const { theme } = useTheme()
  const shared = props.shared
  const selection = resolveRowSelectionChrome(theme, {
    cursor: shared.cursorIndex === props.flatIndex,
    selected: shared.activeRowId === props.rowId,
  })
  return (
    <box
      ref={(renderable: BoxRenderable | null) => {
        if (!renderable) return
        shared.rowEls.set(props.flatIndex, renderable)
        return () => {
          if (shared.rowEls.get(props.flatIndex) === renderable) shared.rowEls.delete(props.flatIndex)
        }
      }}
      width="100%"
      flexDirection="row"
      gap={0}
      backgroundColor={selection.backgroundColor}
      onMouseUp={(evt: { button: number; x: number; y: number; stopPropagation(): void }) => {
        // Don't bubble to the pane box's focus-grab (the workspace host's
        // sidebar shell): activating a row hands focus to the CONTENT pane,
        // and a bubbled sidebar re-grab overwrote it — the user typed into
        // what looked like the terminal while the sidebar's letter chords
        // (d!) were live. Same guard the ZEN chip carries.
        evt.stopPropagation()
        // Right-click opens the row's menu instead of activating it — the
        // terminal only forwards button 2 while mouse reporting is on, which
        // is the same mode the left-click activate already depends on.
        if (evt.button === MouseButton.RIGHT && shared.onContextMenu) {
          shared.onContextMenu(props.flatIndex, props.rowId, evt.x, evt.y)
          return
        }
        shared.onPress(props.flatIndex, props.rowId)
      }}
    >
      <text fg={selection.markerColor} wrapMode="none">
        {selection.marker}
      </text>
      <text wrapMode="none" flexShrink={0}>
        {" ".repeat(props.depth * INDENT_CELLS)}
      </text>
      {props.children}
    </box>
  )
}

/**
 * A worktree row carries NO state glyph (owner call 2026-08-01, round 6):
 * the session state belongs to the chattab that runs it, so the glyph lives
 * on the tab row below. What stays here is worktree-level fact — branch,
 * pin, PR chip, ±change stats.
 */
export function WorktreeTreeRow(props: {
  readonly rowId: string
  readonly flatIndex: number
  readonly task: Task
  readonly shared: TreeRowShared
}) {
  const { theme } = useTheme()
  const shared = props.shared
  const task = props.task
  const isCursor = shared.cursorIndex === props.flatIndex
  const changes = useChanges(shared, task)
  const chip = prCheckChip(task)
  // A worktree row is named by its BRANCH. A `main` row stores no branch
  // (its checkout moves freely), so it polls the repo HEAD — falling back
  // to the title repeated the project header's name right under it (owner
  // 2026-08-02), which read as a duplicate row instead of "the main
  // checkout, currently on <branch>".
  const isMain = task.kind === "main"
  useEffect(() => {
    // Dependency-only invalidation key: re-poll on the sidebar's ~2s tick.
    void shared.branchTick
    if (isMain) pollCurrentBranch(task.repo)
  }, [isMain, task.repo, shared.branchTick])
  const label = (isMain ? currentBranch(task.repo) : task.branch) || task.branch || task.title
  return (
    <RowShell rowId={props.rowId} flatIndex={props.flatIndex} depth={1} shared={shared}>
      <box flexDirection="row" flexGrow={1} paddingRight={1} gap={1}>
        <text fg={theme.text} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
          {label}
        </text>
        {task.pinned === true ? (
          <text fg={theme.warning} wrapMode="none" flexShrink={0}>
            ▴
          </text>
        ) : null}
        {chip ? (
          <text fg={toneColor(theme, chip.tone)} wrapMode="none" flexShrink={0}>
            {chip.glyph}
          </text>
        ) : null}
        <ChangeStats changes={changes} />
        <JumpDigit flatIndex={props.flatIndex} dim={!isCursor} />
      </box>
    </RowShell>
  )
}

export function TabTreeRow(props: {
  readonly rowId: string
  readonly flatIndex: number
  readonly task: Task
  readonly tab: TreeTab
  readonly shared: TreeRowShared
}) {
  const { theme } = useTheme()
  const shared = props.shared
  const isCursor = shared.cursorIndex === props.flatIndex
  // Glyph rule (owner round 7): an AGENT tab always wears the state circle
  // vocabulary — `○` at rest, live state glyph when the daemon reports
  // activity for its session (the ACTIVE engine tab; activity is
  // task-scoped). A non-agent tab (shell/command/content) is outside the
  // vocabulary — plain `·`, we don't care about its state.
  const isAgent = props.tab.engine === true
  // Prefer THIS tab's own activity over the task rollup. The daemon reports
  // both levels, but the task entry is last-event-wins across every tab — so
  // a task whose live work is in tab-2 reads as whatever tab-N reported most
  // recently, and a genuinely running row sat at `○` until you opened it.
  // Tab-level is the precise answer; the rollup stays the fallback for
  // sessions kobe didn't spawn as a tab (a hand-typed `claude` in a shell
  // reports task-level only — see the `engine-state` channel contract).
  const taskTabStates = isAgent ? shared.engineTabState?.get(props.task.id) : undefined
  // Rule (and the reason the rollup is gated) lives in `tabRowActivity`.
  const activity = isAgent
    ? tabRowActivity({
        tabActivity: taskTabStates?.get(props.tab.id),
        reportedTabCount: taskTabStates?.size ?? 0,
        taskActivity: shared.engineState?.get(props.task.id),
        active: props.tab.active === true,
      })
    : undefined
  // One predicate now: "does this row have activity of its own". It used to
  // also count "is the active tab", which is what let the rollup leak in.
  const carriesState = activity !== undefined
  // The unread lamp (herdr ● on turn_complete) is for sessions you are NOT
  // looking at — sitting in the tab digests it to ✓ on the same render.
  // "Viewing" = this row's TASK is selected and this tab is the task's
  // active one. ONLY the row that carries the task's activity may run the
  // bookkeeping: a sibling tab passes state=undefined, and letting it call
  // would fire the delete branch and wipe the seen bit the active row just
  // recorded — the ✓ → ● → ✓ flip on every task switch.
  const viewing = shared.selectedTaskId === props.task.id && props.tab.active === true
  // Per-TAB seen bit: sibling tab rows of the same task render in this very
  // pass and would otherwise share (and clear) one task-wide mark. The
  // durable half survives a kobe restart, which the daemon's activity entry
  // does too — without it every read completion came back ● (issue #22).
  const durableSeen = useDurableCompletionSeen(
    props.task.id,
    props.tab.id,
    carriesState ? completionStampOf(activity) : undefined,
    viewing,
  )
  const completionSeen = carriesState
    ? completionSeenFor(props.task.id, activity?.state, viewing, props.tab.id, durableSeen)
    : false
  const baseView = buildSidebarRowView({
    task: props.task,
    activity,
    lifecycle: carriesState ? shared.engineLifecycle?.get(props.task.id) : undefined,
    job: carriesState ? shared.taskJobs?.get(props.task.id) : undefined,
    spinnerFrame: 0,
    subtitleBudget: 0,
    truncateBranch: truncateBranchLabel,
    completionSeen,
  })
  const frame = useSpinnerFrame(carriesState && baseView.loading)
  const rowView = withSpinnerFrame(baseView, () => frame)
  // Glyph precedence for an agent row: with any daemon signal (running /
  // sticky badge / a KNOWN-idle tombstone) the row wears the shared state
  // vocabulary — buildSidebarRowView rests at `○` for known-idle. With NO
  // signal at all (fresh daemon before its first observer pass, dead daemon
  // lineage — issue #11) it rests at the same dim dot a non-agent tab wears.
  // That case used to have its own dotted `◌` for "the daemon doesn't know",
  // distinct from `○ idle` — dropped 2026-08-15 as a distinction without a
  // difference: both readings send you into the tab to find out, and U+25CC
  // is missing from common terminal fonts, so it fell back oversized and ran
  // into the label. See NO_STATE_GLYPH.
  const glyph = isAgent && carriesState ? rowView.stateGlyph : NO_STATE_GLYPH
  return (
    <RowShell rowId={props.rowId} flatIndex={props.flatIndex} depth={2} shared={props.shared}>
      <text
        fg={carriesState ? toneColor(theme, rowView.tone) : theme.textMuted}
        wrapMode="none"
        width={2}
        flexShrink={0}
      >
        {`${glyph} `}
      </text>
      <box flexDirection="row" flexGrow={1} paddingRight={1} gap={1}>
        <text fg={theme.textMuted} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
          {props.tab.label}
        </text>
        <JumpDigit flatIndex={props.flatIndex} dim={!isCursor} />
      </box>
    </RowShell>
  )
}

/**
 * Narrow mode's "↩ Recent: <task>" jump row (issue #14, 2A) — the first
 * navigable row of the narrow sidebar. ⏎ re-enters the named task's
 * workspace; it answers to nothing else (no menu, no per-task verbs).
 */
export function RecentJumpRow(props: {
  readonly rowId: string
  readonly flatIndex: number
  readonly task: Task
  readonly shared: TreeRowShared
}) {
  const { theme } = useTheme()
  const t = useT()
  return (
    <RowShell rowId={props.rowId} flatIndex={props.flatIndex} depth={1} shared={props.shared}>
      <text fg={theme.accent} wrapMode="none" width={2} flexShrink={0}>
        {"↩ "}
      </text>
      <text fg={theme.text} wrapMode="none" flexShrink={1}>
        {t("tasks.recentJump", { title: props.task.title })}
      </text>
    </RowShell>
  )
}
