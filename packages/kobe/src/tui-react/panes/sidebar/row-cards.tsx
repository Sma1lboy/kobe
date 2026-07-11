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
import { type ReactNode, useEffect, useMemo } from "react"
import { sweepBar } from "../../../tui/lib/progress-bar"
import { currentBranch, pollCurrentBranch } from "../../../tui/panes/sidebar/git-head"
import type { SidebarRow } from "../../../tui/panes/sidebar/groups"
import { spacedTitle } from "../../../tui/panes/sidebar/labels"
import {
  type SidebarRowView,
  buildSidebarRowView,
  prCheckChip,
  withSpinnerFrame,
} from "../../../tui/panes/sidebar/row-view"
import { taskIsLive, toneColor, truncateBranchLabel } from "../../../tui/panes/sidebar/view-core"
import { type WorktreeChanges, pickPushedChanges } from "../../../tui/panes/sidebar/worktree-changes"
import { pollWorktreeChanges, worktreeChanges } from "../../../tui/panes/sidebar/worktree-changes-poller"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { resolveRowSelectionChrome } from "../../ui/row-selection-chrome"
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

/**
 * Subtitle line of a row card — Solid `SubtitleText`'s React counterpart.
 * Plain muted text, except a materialising row, which renders the
 * indeterminate sweep bar ahead of the word.
 */
function SubtitleText(props: { readonly view: SidebarRowView; readonly frame: number }) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  if (!props.view.materializing || themeCtx.reducedMotion) {
    return (
      <text fg={theme.textMuted} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
        {props.view.subtitleText}
      </text>
    )
  }
  return (
    <box flexDirection="row" gap={1} flexBasis={0} flexGrow={1} flexShrink={1}>
      <text fg={theme.primary} wrapMode="none">
        {sweepBar(props.frame)}
      </text>
      <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
        {props.view.subtitleText}
      </text>
    </box>
  )
}

/** Right-edge git metrics stay one non-shrinking cluster while metadata takes
 * the flexible middle column. This keeps every row scannable at the same
 * visual anchor even when a branch/title is long. */
function ChangeStats(props: { readonly changes: WorktreeChanges }) {
  const { theme } = useTheme()
  if (props.changes.added <= 0 && props.changes.deleted <= 0) return null
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      {props.changes.added > 0 ? (
        <text fg={theme.success} wrapMode="none" flexShrink={0}>
          +{props.changes.added}
        </text>
      ) : null}
      {props.changes.deleted > 0 ? (
        <text fg={theme.error} wrapMode="none" flexShrink={0}>
          −{props.changes.deleted}
        </text>
      ) : null}
    </box>
  )
}

function RowBody(props: {
  readonly row: SidebarRow
  readonly shared: SidebarRowCardSharedProps
  readonly selection: ReturnType<typeof resolveRowSelectionChrome>
  readonly children: ReactNode
}) {
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
      backgroundColor={props.selection.backgroundColor}
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

/**
 * Shared per-card derivation — cursor/selection chrome, `+N −M` counts, and
 * the framework-free row view — identical between the project and task
 * cards; only `mainBranch` (project rows poll the repo HEAD) differs.
 */
function useRowCardChrome(row: SidebarRow, shared: SidebarRowCardSharedProps, opts: { mainBranch: string }) {
  const t = useT()
  const themeCtx = useTheme()
  const { theme, reducedMotion } = themeCtx
  const task = row.task
  const isCursor = row.flatIndex === shared.cursorIndex
  const isSelected = task.id === shared.selectedId
  const selection = resolveRowSelectionChrome(theme, { cursor: isCursor, selected: isSelected })
  const changes = useChanges(shared, task)
  const activity = shared.engineState?.get(task.id)
  const job = shared.taskJobs?.get(task.id)
  const live = taskIsLive(task.id, shared.chatRunState)
  const { subtitleBudget } = shared
  const { mainBranch } = opts
  // Memoized on the real inputs so the 10Hz spinner tick (a fresh `shared`
  // object every render) doesn't re-derive idle rows.
  const baseView = useMemo(() => {
    // Dependency-only invalidation key: rebuild when the language changes —
    // buildSidebarRowView reads the global `t` through the locale store.
    void t
    return buildSidebarRowView({
      task,
      activity,
      job,
      live,
      spinnerFrame: 0,
      subtitleBudget,
      truncateBranch: truncateBranchLabel,
      mainBranch,
      reducedMotion,
      // Defer to the live terminal when this task's pane is the one on screen.
      isViewed: isSelected,
    })
  }, [task, activity, job, live, subtitleBudget, mainBranch, reducedMotion, isSelected, t])
  // Frame overlay stays OUTSIDE the memo: non-loading rows come back as the
  // same object, so an idle row does zero per-frame derivation.
  const rowView = withSpinnerFrame(baseView, () => shared.spinnerFrame)
  return { theme, task, isCursor, isSelected, selection, changes, rowView }
}

/** One marker-prefixed line of a two-line row card. */
function RowLine(props: {
  readonly selection: ReturnType<typeof resolveRowSelectionChrome>
  readonly children: ReactNode
}) {
  return (
    <box flexDirection="row" gap={0}>
      <text fg={props.selection.markerColor} wrapMode="none">
        {props.selection.marker}
      </text>
      {props.children}
    </box>
  )
}

export function ProjectRowCard(props: { row: SidebarRow; shared: SidebarRowCardSharedProps }) {
  const shared = props.shared
  const task = props.row.task
  useEffect(() => {
    // Dependency-only invalidation key: re-poll on the sidebar's ~2s tick.
    void shared.branchTick
    pollCurrentBranch(task.repo)
  }, [task.repo, shared.branchTick])
  const { theme, selection, changes, rowView } = useRowCardChrome(props.row, shared, {
    mainBranch: currentBranch(task.repo),
  })
  const stateColor = !rowView.loading ? theme.primary : toneColor(theme, rowView.tone)

  return (
    <box flexDirection="column" gap={0} paddingBottom={0}>
      <RowBody row={props.row} shared={shared} selection={selection}>
        <RowLine selection={selection}>
          <box flexDirection="row" flexGrow={1} paddingRight={1} gap={0}>
            <text fg={stateColor} attributes={TextAttributes.BOLD} wrapMode="none" width={1} flexShrink={0}>
              {rowView.projectGlyph}
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
              {spacedTitle(rowView.titleText, shared.titleBudget)}
            </text>
          </box>
        </RowLine>
        <RowLine selection={selection}>
          <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
            <SubtitleText view={rowView} frame={shared.spinnerFrame} />
            <ChangeStats changes={changes} />
          </box>
        </RowLine>
      </RowBody>
    </box>
  )
}

export function TaskRowCard(props: { row: SidebarRow; shared: SidebarRowCardSharedProps }) {
  const t = useT()
  const shared = props.shared
  const task = props.row.task
  const { theme, isCursor, isSelected, selection, changes, rowView } = useRowCardChrome(props.row, shared, {
    mainBranch: "",
  })
  const stateColor = toneColor(theme, rowView.tone)
  const chip = prCheckChip(task)

  return (
    <box flexDirection="column" gap={0} paddingBottom={1}>
      <RowBody row={props.row} shared={shared} selection={selection}>
        <RowLine selection={selection}>
          <box flexDirection="row" flexGrow={1} paddingRight={1} gap={0}>
            <text fg={stateColor} attributes={TextAttributes.BOLD} wrapMode="none" width={1} flexShrink={0}>
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
        </RowLine>
        <RowLine selection={selection}>
          <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
            <SubtitleText view={rowView} frame={shared.spinnerFrame} />
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
            <ChangeStats changes={changes} />
          </box>
        </RowLine>
      </RowBody>
    </box>
  )
}
