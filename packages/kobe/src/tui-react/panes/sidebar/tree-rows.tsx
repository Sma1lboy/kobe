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
import type { ReactNode } from "react"
import { buildSidebarRowView, prCheckChip, withSpinnerFrame } from "../../../tui/panes/sidebar/row-view"
import type { TreeTab } from "../../../tui/panes/sidebar/tree-core"
import { toneColor, truncateBranchLabel } from "../../../tui/panes/sidebar/view-core"
import type { WorktreeChanges } from "../../../tui/panes/sidebar/worktree-changes"
import { useTheme } from "../../context/theme"
import { resolveRowSelectionChrome } from "../../ui/row-selection-chrome"
import { ChangeStats, JumpDigit, useChanges, useSpinnerFrame } from "./row-cards"

/** Cells of indent per depth level. Two reads as a level without eating the
 *  rail's narrow width the way four would. */
const INDENT_CELLS = 2

export type TreeRowShared = {
  /** Cursor position in the tree's flat id list. */
  readonly cursorIndex: number
  /** The row id the right pane is showing (`taskId::tabId` when a tab). */
  readonly activeRowId: string | null
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
      onMouseUp={(evt: { button: number; x: number; y: number }) => {
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
  // A worktree row is named by its BRANCH (a task worktree's identity), the
  // title only as fallback for a branchless row.
  const label = task.branch || task.title
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
  const activity = isAgent && props.tab.active === true ? shared.engineState?.get(props.task.id) : undefined
  const carriesState = activity !== undefined
  const baseView = buildSidebarRowView({
    task: props.task,
    activity,
    lifecycle: carriesState ? shared.engineLifecycle?.get(props.task.id) : undefined,
    job: carriesState ? shared.taskJobs?.get(props.task.id) : undefined,
    spinnerFrame: 0,
    subtitleBudget: 0,
    truncateBranch: truncateBranchLabel,
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
