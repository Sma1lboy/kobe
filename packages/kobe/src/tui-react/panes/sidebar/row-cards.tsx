/** @jsxImportSource @opentui/react */
/**
 * React sidebar row cards (issue #15, G3) — the
 * `src/tui/panes/sidebar/row-cards.tsx` counterpart. Row derivation
 * (`buildSidebarRowView`), the `+N −M` pollers, and the tone/label helpers
 * are the shared framework-free modules; this file owns only React
 * rendering.
 *
 * Poller contract (async canon): the fire-and-forget `poll*` calls live in
 * effects keyed on the Sidebar's `branchTick` (never in render), while the
 * cached `read` side (`worktreeChanges` / `currentBranch`) is a plain
 * synchronous getter read at render time. A finishing poll surfaces on the
 * next tick re-render (≤100ms via the spinner tick) instead of notifying —
 * the Solid signal's push is replaced by the tick's pull.
 */

import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import { type BoxRenderable, TextAttributes } from "@opentui/core"
import { type ReactNode, useEffect } from "react"
import { currentBranch, pollCurrentBranch } from "../../../tui/panes/sidebar/git-head"
import type { SidebarRow } from "../../../tui/panes/sidebar/groups"
import { spacedTitle } from "../../../tui/panes/sidebar/labels"
import { buildSidebarRowView, prCheckChip, withSpinnerFrame } from "../../../tui/panes/sidebar/row-view"
import { taskIsLive, toneColor, truncateBranchLabel } from "../../../tui/panes/sidebar/view-core"
import { type WorktreeChanges, pickPushedChanges } from "../../../tui/panes/sidebar/worktree-changes"
import { pollWorktreeChanges, worktreeChanges } from "../../../tui/panes/sidebar/worktree-changes-poller"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import type { ChatRunState, SidebarHover } from "./types"

export type SidebarRowCardSharedProps = {
  readonly selectedId: string | null
  readonly cursorIndex: number
  readonly setCursorIndex: (index: number) => void
  readonly rowEls: Map<number, BoxRenderable>
  readonly onSelect: (id: string) => void
  readonly activateRow: (id: string) => void
  readonly activateOnClick?: boolean
  readonly setHover: (hover: SidebarHover | null) => void
  readonly clearHoverForTask: (taskId: string) => void
  readonly branchTick: number
  readonly spinnerFrame: number
  readonly titleBudget: number
  readonly subtitleBudget: number
  readonly chatRunState?: ReadonlyMap<string, ChatRunState>
  readonly engineState?: ReadonlyMap<string, TaskEngineState>
  readonly taskJobs?: ReadonlyMap<string, TaskJobState>
  readonly worktreeChanges?: ReadonlyMap<string, WorktreeChanges> | null
  readonly moveMode?: boolean
}

/**
 * Per-row `+N −M` counts: daemon-pushed when available, else the local
 * poller cache (poll scheduled in an effect; archived rows never poll).
 */
function useChanges(shared: SidebarRowCardSharedProps, task: SidebarRow["task"]): WorktreeChanges {
  const pushed = pickPushedChanges(shared.worktreeChanges, task.worktreePath)
  const hasPushed = pushed !== null
  useEffect(() => {
    // Dependency-only invalidation key: re-poll on the sidebar's ~2s tick.
    void shared.branchTick
    if (hasPushed || task.archived) return
    pollWorktreeChanges(task.worktreePath)
  }, [hasPushed, task.archived, task.worktreePath, shared.branchTick])
  return pushed ?? worktreeChanges(task.worktreePath)
}

function RowBody(props: {
  readonly row: SidebarRow
  readonly shared: SidebarRowCardSharedProps
  readonly children: ReactNode
}) {
  const { theme } = useTheme()
  const task = props.row.task
  const flatIndex = props.row.flatIndex
  const shared = props.shared
  return (
    // biome-ignore lint/a11y/useKeyWithMouseEvents: opentui terminal UI has no DOM focus model; hover is pointer-only while keyboard nav exposes the same row detail by selection.
    <box
      ref={(renderable: BoxRenderable | null) => {
        if (!renderable) return
        shared.rowEls.set(flatIndex, renderable)
        // React 19 ref cleanup — same "only if still ours" guard as Solid.
        return () => {
          if (shared.rowEls.get(flatIndex) === renderable) shared.rowEls.delete(flatIndex)
        }
      }}
      width="100%"
      flexDirection="column"
      gap={0}
      backgroundColor={flatIndex === shared.cursorIndex ? theme.backgroundElement : undefined}
      onMouseUp={() => {
        shared.setCursorIndex(flatIndex)
        shared.onSelect(task.id)
        if (shared.activateOnClick) shared.activateRow(task.id)
      }}
      onMouseOver={(event) => shared.setHover({ task, x: event.x, y: event.y })}
      onMouseOut={() => shared.clearHoverForTask(task.id)}
    >
      {props.children}
    </box>
  )
}

export function ProjectRowCard(props: { row: SidebarRow; shared: SidebarRowCardSharedProps }) {
  const { theme } = useTheme()
  const shared = props.shared
  const task = props.row.task
  const flatIndex = props.row.flatIndex
  const isCursor = flatIndex === shared.cursorIndex
  const isSelected = task.id === shared.selectedId
  const changes = useChanges(shared, task)
  useEffect(() => {
    // Dependency-only invalidation key: re-poll on the sidebar's ~2s tick.
    void shared.branchTick
    pollCurrentBranch(task.repo)
  }, [task.repo, shared.branchTick])
  const rowView = withSpinnerFrame(
    buildSidebarRowView({
      task,
      activity: shared.engineState?.get(task.id),
      job: shared.taskJobs?.get(task.id),
      live: taskIsLive(task.id, shared.chatRunState),
      spinnerFrame: 0,
      subtitleBudget: shared.subtitleBudget,
      truncateBranch: truncateBranchLabel,
      mainBranch: currentBranch(task.repo),
    }),
    () => shared.spinnerFrame,
  )
  const stateColor = !rowView.loading ? theme.primary : toneColor(theme, rowView.tone)
  const barColor = isCursor ? theme.focusAccent : isSelected ? theme.primary : undefined
  const barGlyph = isCursor || isSelected ? "▌" : " "

  return (
    <box flexDirection="column" gap={0} paddingBottom={0}>
      <RowBody row={props.row} shared={shared}>
        <box flexDirection="row" gap={0}>
          <text fg={barColor} wrapMode="none">
            {barGlyph}
          </text>
          <box flexDirection="row" flexGrow={1} paddingRight={1} gap={0}>
            <text fg={stateColor} attributes={TextAttributes.BOLD} wrapMode="none">
              {rowView.projectGlyph}
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
              {spacedTitle(rowView.titleText, shared.titleBudget)}
            </text>
          </box>
        </box>
        <box flexDirection="row" gap={0}>
          <text fg={barColor} wrapMode="none">
            {barGlyph}
          </text>
          <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none" flexGrow={1}>
              {rowView.subtitleText}
            </text>
            {changes.added > 0 ? (
              <text fg={theme.success} wrapMode="none">
                +{changes.added}
              </text>
            ) : null}
            {changes.deleted > 0 ? (
              <text fg={theme.error} wrapMode="none">
                −{changes.deleted}
              </text>
            ) : null}
          </box>
        </box>
      </RowBody>
    </box>
  )
}

export function TaskRowCard(props: { row: SidebarRow; shared: SidebarRowCardSharedProps }) {
  const { theme } = useTheme()
  const t = useT()
  const shared = props.shared
  const task = props.row.task
  const flatIndex = props.row.flatIndex
  const isCursor = flatIndex === shared.cursorIndex
  const isSelected = task.id === shared.selectedId
  const changes = useChanges(shared, task)
  const rowView = withSpinnerFrame(
    buildSidebarRowView({
      task,
      activity: shared.engineState?.get(task.id),
      job: shared.taskJobs?.get(task.id),
      live: taskIsLive(task.id, shared.chatRunState),
      spinnerFrame: 0,
      subtitleBudget: shared.subtitleBudget,
      truncateBranch: truncateBranchLabel,
      mainBranch: "",
    }),
    () => shared.spinnerFrame,
  )
  const stateColor = toneColor(theme, rowView.tone)
  const barColor = isCursor ? theme.focusAccent : isSelected ? theme.primary : undefined
  const barGlyph = isCursor || isSelected ? "▌" : " "
  const chip = prCheckChip(task)

  return (
    <box flexDirection="column" gap={0} paddingBottom={1}>
      <RowBody row={props.row} shared={shared}>
        <box flexDirection="row" gap={0}>
          <text fg={barColor} wrapMode="none">
            {barGlyph}
          </text>
          <box flexDirection="row" flexGrow={1} paddingRight={1} gap={0}>
            <text fg={stateColor} attributes={TextAttributes.BOLD} wrapMode="none">
              {rowView.stateGlyph}
            </text>
            <text
              fg={theme.text}
              attributes={isSelected || isCursor ? TextAttributes.BOLD : undefined}
              wrapMode="none"
              flexGrow={1}
            >
              {spacedTitle(rowView.titleText, shared.titleBudget)}
            </text>
            {shared.moveMode && isCursor ? (
              <text fg={theme.warning} wrapMode="none">
                {t("tasks.moveChip")}
              </text>
            ) : null}
          </box>
        </box>
        <box flexDirection="row" gap={0}>
          <text fg={barColor} wrapMode="none">
            {barGlyph}
          </text>
          <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
            <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none" flexGrow={1}>
              {rowView.subtitleText}
            </text>
            {task.pinned === true ? (
              <text fg={theme.warning} wrapMode="none">
                ▴
              </text>
            ) : null}
            {chip ? (
              <text fg={toneColor(theme, chip.tone)} wrapMode="none">
                {chip.glyph}
              </text>
            ) : null}
            {changes.added > 0 ? (
              <text fg={theme.success} wrapMode="none">
                +{changes.added}
              </text>
            ) : null}
            {changes.deleted > 0 ? (
              <text fg={theme.error} wrapMode="none">
                −{changes.deleted}
              </text>
            ) : null}
          </box>
        </box>
      </RowBody>
    </box>
  )
}
