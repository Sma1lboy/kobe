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
import { buildSidebarRowView, prCheckChip, withSpinnerFrame } from "../../../tui/panes/sidebar/row-view"
import type { TaskDelegationMarks } from "../../../tui/panes/sidebar/task-delegation-marks"
import type { TreeTab } from "../../../tui/panes/sidebar/tree-core"
import { toneColor, truncateBranchLabel } from "../../../tui/panes/sidebar/view-core"
import type { WorktreeChanges } from "../../../tui/panes/sidebar/worktree-changes"
import { useTheme } from "../../context/theme"
import { resolveRowSelectionChrome } from "../../ui/row-selection-chrome"
import {
  ChangeStats,
  JumpDigit,
  PrimarySubagentChip,
  SubagentLinkGlyph,
  completionSeenFor,
  useChanges,
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
  readonly engineLifecycle?: ReadonlyMap<string, { readonly subagents: number }>
  readonly taskJobs?: ReadonlyMap<string, TaskJobState>
  readonly worktreeChanges?: ReadonlyMap<string, WorktreeChanges> | null
  readonly taskDelegationMarks?: ReadonlyMap<string, TaskDelegationMarks>
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
  const delegationMarks = shared.taskDelegationMarks?.get(String(task.id))
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
        <SubagentLinkGlyph visible={delegationMarks?.isSubagent === true} />
        <text fg={theme.text} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
          {label}
        </text>
        <PrimarySubagentChip count={delegationMarks?.subagentCount ?? 0} padded={false} />
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
  const carriesActivity = isAgent && props.tab.active === true
  const activity = carriesActivity ? shared.engineState?.get(props.task.id) : undefined
  const carriesState = activity !== undefined
  // The unread lamp (herdr ● on turn_complete) is for sessions you are NOT
  // looking at — sitting in the tab digests it to ✓ on the same render.
  // "Viewing" = this row's TASK is selected and this tab is the task's
  // active one. ONLY the row that carries the task's activity may run the
  // bookkeeping: a sibling tab passes state=undefined, and letting it call
  // would fire the delete branch and wipe the seen bit the active row just
  // recorded — the ✓ → ● → ✓ flip on every task switch.
  const viewing = shared.selectedTaskId === props.task.id && props.tab.active === true
  const completionSeen = carriesActivity ? completionSeenFor(props.task.id, activity?.state, viewing) : false
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
  // buildSidebarRowView already rests at `○` with no activity, so an agent
  // row can take its glyph unconditionally.
  const glyph = isAgent ? rowView.stateGlyph : "·"
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
