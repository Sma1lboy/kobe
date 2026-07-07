import type { TaskEngineState, TaskJobState } from "@/client/remote-orchestrator"
import { t } from "@/tui/i18n"
import { type BoxRenderable, TextAttributes } from "@opentui/core"
import type { Accessor, JSX } from "solid-js"
import { Show, createMemo, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import { sweepBar } from "../../lib/progress-bar"
import { currentBranch, pollCurrentBranch } from "./git-head"
import type { SidebarRow } from "./groups"
import { spacedTitle } from "./labels"
import { type SidebarRowView, buildSidebarRowView, prCheckChip, withSpinnerFrame } from "./row-view"
import type { ChatRunState, SidebarHover } from "./types"
import { taskIsLive, toneColor, truncateBranchLabel } from "./view-core"
import { type WorktreeChanges, pickPushedChanges, sameWorktreeChanges } from "./worktree-changes"
import { pollWorktreeChanges, worktreeChanges } from "./worktree-changes-poller"

export type SidebarRowCardSharedProps = {
  readonly selectedId: Accessor<string | null>
  readonly cursorIndex: Accessor<number>
  readonly setCursorIndex: (index: number) => void
  readonly rowEls: Map<number, BoxRenderable>
  readonly onSelect: (id: string) => void
  readonly activateRow: (id: string) => void
  readonly activateOnClick?: boolean
  readonly setHover: (hover: SidebarHover | null) => void
  readonly clearHoverForTask: (taskId: string) => void
  readonly branchTick: Accessor<number>
  readonly spinnerFrame: Accessor<number>
  readonly titleBudget: Accessor<number>
  readonly subtitleBudget: Accessor<number>
  readonly chatRunState?: Accessor<ReadonlyMap<string, ChatRunState>>
  readonly engineState?: Accessor<ReadonlyMap<string, TaskEngineState>>
  readonly taskJobs?: Accessor<ReadonlyMap<string, TaskJobState>>
  readonly worktreeChanges?: Accessor<ReadonlyMap<string, WorktreeChanges> | null>
  readonly moveMode?: Accessor<boolean>
}

function useChanges(props: SidebarRowCardSharedProps, task: SidebarRow["task"]) {
  return createMemo(
    () => {
      const pushed = pickPushedChanges(props.worktreeChanges?.(), task.worktreePath)
      if (pushed) return pushed
      props.branchTick()
      if (!task.archived) pollWorktreeChanges(task.worktreePath)
      return worktreeChanges(task.worktreePath)
    },
    undefined,
    { equals: sameWorktreeChanges },
  )
}

/**
 * Subtitle line of a row card. Plain muted text, except a materialising
 * row (worktree add in flight), which renders the indeterminate sweep bar
 * ahead of the word. Frame is read only in that branch, so ordinary rows
 * never subscribe to the 10Hz signal (same conditional-dependency contract
 * as `withSpinnerFrame`).
 */
function SubtitleText(props: { readonly view: () => SidebarRowView; readonly frame: Accessor<number> }) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  return (
    <Show
      when={props.view().materializing && !themeCtx.reducedMotion}
      fallback={
        <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none" flexGrow={1}>
          {props.view().subtitleText}
        </text>
      }
    >
      <box flexDirection="row" gap={1} flexGrow={1}>
        <text fg={theme.primary} wrapMode="none">
          {sweepBar(props.frame())}
        </text>
        <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
          {props.view().subtitleText}
        </text>
      </box>
    </Show>
  )
}

function RowBody(props: {
  readonly row: SidebarRow
  readonly shared: SidebarRowCardSharedProps
  readonly children: JSX.Element
}) {
  const { theme } = useTheme()
  const task = props.row.task
  const flatIndex = props.row.flatIndex
  return (
    // biome-ignore lint/a11y/useKeyWithMouseEvents: opentui terminal UI has no DOM focus model; hover is pointer-only while keyboard nav exposes the same row detail by selection.
    <box
      ref={(renderable: BoxRenderable) => {
        props.shared.rowEls.set(flatIndex, renderable)
        onCleanup(() => {
          if (props.shared.rowEls.get(flatIndex) === renderable) props.shared.rowEls.delete(flatIndex)
        })
      }}
      width="100%"
      flexDirection="column"
      gap={0}
      backgroundColor={flatIndex === props.shared.cursorIndex() ? theme.backgroundElement : undefined}
      onMouseUp={() => {
        props.shared.setCursorIndex(flatIndex)
        props.shared.onSelect(task.id)
        if (props.shared.activateOnClick) props.shared.activateRow(task.id)
      }}
      onMouseOver={(event) => props.shared.setHover({ task, x: event.x, y: event.y })}
      onMouseOut={() => props.shared.clearHoverForTask(task.id)}
    >
      {props.children}
    </box>
  )
}

export function ProjectRowCard(props: { row: SidebarRow; shared: SidebarRowCardSharedProps }) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const task = props.row.task
  const flatIndex = props.row.flatIndex
  const isCursor = () => flatIndex === props.shared.cursorIndex()
  const isSelected = () => task.id === props.shared.selectedId()
  const changes = useChanges(props.shared, task)
  const projectBranch = createMemo(() => {
    props.shared.branchTick()
    pollCurrentBranch(task.repo)
    return currentBranch(task.repo)
  })
  const baseRowView = createMemo(() =>
    buildSidebarRowView({
      task,
      activity: props.shared.engineState?.().get(task.id),
      job: props.shared.taskJobs?.().get(task.id),
      live: taskIsLive(task.id, props.shared.chatRunState?.()),
      spinnerFrame: 0,
      subtitleBudget: props.shared.subtitleBudget(),
      truncateBranch: truncateBranchLabel,
      mainBranch: projectBranch(),
      reducedMotion: themeCtx.reducedMotion,
    }),
  )
  const rowView = createMemo(() => withSpinnerFrame(baseRowView(), props.shared.spinnerFrame))
  const stateColor = () => (!rowView().loading ? theme.primary : toneColor(theme, rowView().tone))
  const barColor = () => (isCursor() ? theme.focusAccent : isSelected() ? theme.primary : undefined)
  const barGlyph = () => (isCursor() || isSelected() ? "▌" : " ")

  return (
    <box flexDirection="column" gap={0} paddingBottom={0}>
      <RowBody row={props.row} shared={props.shared}>
        <box flexDirection="row" gap={0}>
          <text fg={barColor()} wrapMode="none">
            {barGlyph()}
          </text>
          <box flexDirection="row" flexGrow={1} paddingRight={1} gap={0}>
            <text fg={stateColor()} attributes={TextAttributes.BOLD} wrapMode="none">
              {rowView().projectGlyph}
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
              {spacedTitle(rowView().titleText, props.shared.titleBudget())}
            </text>
          </box>
        </box>
        <box flexDirection="row" gap={0}>
          <text fg={barColor()} wrapMode="none">
            {barGlyph()}
          </text>
          <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
            <SubtitleText view={rowView} frame={props.shared.spinnerFrame} />
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
      </RowBody>
    </box>
  )
}

export function TaskRowCard(props: { row: SidebarRow; shared: SidebarRowCardSharedProps }) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const task = props.row.task
  const flatIndex = props.row.flatIndex
  const isCursor = () => flatIndex === props.shared.cursorIndex()
  const isSelected = () => task.id === props.shared.selectedId()
  const changes = useChanges(props.shared, task)
  const baseRowView = createMemo(() =>
    buildSidebarRowView({
      task,
      activity: props.shared.engineState?.().get(task.id),
      job: props.shared.taskJobs?.().get(task.id),
      live: taskIsLive(task.id, props.shared.chatRunState?.()),
      spinnerFrame: 0,
      subtitleBudget: props.shared.subtitleBudget(),
      truncateBranch: truncateBranchLabel,
      mainBranch: "",
      reducedMotion: themeCtx.reducedMotion,
    }),
  )
  const rowView = createMemo(() => withSpinnerFrame(baseRowView(), props.shared.spinnerFrame))
  const stateColor = () => toneColor(theme, rowView().tone)
  const barColor = () => (isCursor() ? theme.focusAccent : isSelected() ? theme.primary : undefined)
  const barGlyph = () => (isCursor() || isSelected() ? "▌" : " ")

  return (
    <box flexDirection="column" gap={0} paddingBottom={1}>
      <RowBody row={props.row} shared={props.shared}>
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
              {spacedTitle(rowView().titleText, props.shared.titleBudget())}
            </text>
            <Show when={props.shared.moveMode?.() && isCursor()}>
              <text fg={theme.warning} wrapMode="none">
                {t("tasks.moveChip")}
              </text>
            </Show>
          </box>
        </box>
        <box flexDirection="row" gap={0}>
          <text fg={barColor()} wrapMode="none">
            {barGlyph()}
          </text>
          <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
            <SubtitleText view={rowView} frame={props.shared.spinnerFrame} />
            <Show when={task.pinned === true}>
              <text fg={theme.warning} wrapMode="none">
                ▴
              </text>
            </Show>
            <Show when={prCheckChip(task)}>
              {(chip) => (
                <text fg={toneColor(theme, chip().tone)} wrapMode="none">
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
      </RowBody>
    </box>
  )
}
