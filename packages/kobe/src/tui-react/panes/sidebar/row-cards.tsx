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
import { type ReactNode, useEffect, useMemo, useSyncExternalStore } from "react"
import { sweepBar } from "../../../tui/lib/progress-bar"
import { spinnerFrameSnapshot, subscribeSpinnerFrame } from "../../../tui/lib/spinner-frame-store"
import { currentBranch, pollCurrentBranch } from "../../../tui/panes/sidebar/git-head"
import type { SidebarRow } from "../../../tui/panes/sidebar/groups"
import { spacedTitle } from "../../../tui/panes/sidebar/labels"
import {
  type SidebarRowView,
  buildSidebarRowView,
  prCheckChip,
  withSpinnerFrame,
} from "../../../tui/panes/sidebar/row-view"
import { toneColor, truncateBranchLabel } from "../../../tui/panes/sidebar/view-core"
import { type WorktreeChanges, pickPushedChanges } from "../../../tui/panes/sidebar/worktree-changes"
import { pollWorktreeChanges, worktreeChanges } from "../../../tui/panes/sidebar/worktree-changes-poller"
import { useOptionalKV } from "../../context/kv"
import { useTheme } from "../../context/theme"
import { useT } from "../../i18n"
import { resolveRowSelectionChrome } from "../../ui/row-selection-chrome"
import { completionSeenAt, completionSeenKey, markCompletionSeen } from "../../workspace/completion-seen"
import type { SidebarHover } from "./types"

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
  readonly titleBudget: number
  readonly subtitleBudget: number
  readonly engineState?: ReadonlyMap<string, TaskEngineState>
  readonly engineLifecycle?: ReadonlyMap<string, { readonly subagents: number }>
  readonly transcriptActivity?: ReadonlyMap<string, { readonly mtimeMs: number }> | null
  readonly taskJobs?: ReadonlyMap<string, TaskJobState>
  readonly worktreeChanges?: ReadonlyMap<string, WorktreeChanges> | null
  readonly moveMode?: boolean
}

const NOOP_SUBSCRIBE = () => () => {}
const ZERO_FRAME = () => 0

/**
 * Per-row spinner pulse — subscribes to the shared 10Hz frame store ONLY
 * while this row actually animates, so a frame tick re-renders the loading
 * rows and nothing else (the old component-level interval re-ran the whole
 * Sidebar per tick). Exported for the tree's one-line worktree rows.
 */
export function useSpinnerFrame(active: boolean): number {
  return useSyncExternalStore(
    active ? subscribeSpinnerFrame : NOOP_SUBSCRIBE,
    active ? spinnerFrameSnapshot : ZERO_FRAME,
  )
}

/**
 * Per-row `+N −M` counts: daemon-pushed when available, else the local
 * poller cache (poll scheduled in an effect; archived rows never poll).
 * `shared` is structural — the card props and the tree's row props both
 * carry the two fields it reads.
 */
export function useChanges(
  shared: Pick<SidebarRowCardSharedProps, "branchTick" | "worktreeChanges">,
  task: SidebarRow["task"],
): WorktreeChanges {
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
function SubtitleText(props: { readonly view: SidebarRowView }) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const animating = props.view.materializing
  const frame = useSpinnerFrame(animating)
  if (!animating) {
    return (
      <text fg={theme.textMuted} wrapMode="none" flexBasis={0} flexGrow={1} flexShrink={1}>
        {props.view.subtitleText}
      </text>
    )
  }
  return (
    <box flexDirection="row" gap={1} flexBasis={0} flexGrow={1} flexShrink={1}>
      <text fg={theme.primary} wrapMode="none">
        {sweepBar(frame)}
      </text>
      <text fg={theme.textMuted} attributes={TextAttributes.DIM} wrapMode="none">
        {props.view.subtitleText}
      </text>
    </box>
  )
}

/** Right-edge git metrics stay one non-shrinking cluster while metadata takes
 * the flexible middle column. This keeps every row scannable at the same
 * visual anchor even when a branch/title is long. Shared with the tree rows. */
export function ChangeStats(props: { readonly changes: WorktreeChanges }) {
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
/**
 * Rows whose CURRENT `turn_complete` the user has already looked at
 * (selected while complete) — the herdr "seen" bit driving ● → ✓. Cleared the
 * moment that row's activity state moves off `turn_complete`.
 *
 * Process-scoped, and that used to be the whole record: the daemon's activity
 * registry outlives the TUI, so relaunching kobe re-lit every completion you
 * had already read (issue #22). The durable mark in `workspace/completion-seen`
 * is what survives the restart; this Set stays the same-render answer.
 *
 * Keyed per ROW (task, or task+tab in the tree), not per task: a task owns
 * several tab rows, and they render in the same pass. With a task-wide key
 * a sibling tab — which legitimately passes `activityState: undefined` —
 * took the clear branch and wiped the bit the completed tab's row had just
 * recorded. Symptom (owner report 2026-08-10): open the tab, the lamp
 * digests to ✓, and it flips back to ● the moment you leave, forever.
 */
const completionSeenIds = new Set<string>()

/**
 * Deterministic render-time seen bookkeeping (herdr ● → ✓), shared with the
 * tree's tab rows: the same render that shows a viewed+complete row must
 * already draw the digested ✓ — an unread lamp on the session you are
 * sitting IN is noise. `viewing` is "this row is what the right pane
 * shows"; the mark clears as soon as activity moves off turn_complete.
 *
 * `tabId` scopes the bit to one tab row; omit it for the flat sidebar's
 * task cards, which own the task's whole activity rollup.
 *
 * `durableSeen` is the persisted answer for the SAME completion (see
 * {@link useDurableCompletionSeen}) — ORed in rather than folded into the
 * Set, because it is computed against the current completion's timestamp and
 * therefore un-sets itself the moment a newer turn completes.
 */
export function completionSeenFor(
  taskId: string,
  activityState: string | undefined,
  viewing: boolean,
  tabId?: string,
  durableSeen = false,
): boolean {
  const key = completionSeenKey(taskId, tabId)
  if (activityState === "turn_complete") {
    if (viewing) completionSeenIds.add(key)
  } else {
    completionSeenIds.delete(key)
  }
  return completionSeenIds.has(key) || durableSeen
}

/** The stamp a row's seen mark is keyed on, or undefined when the row is not
 *  sitting on a completion at all. */
export function completionStampOf(activity: TaskEngineState | undefined): number | undefined {
  return activity?.state === "turn_complete" ? activity.at : undefined
}

/**
 * Persisted half of the seen bit (issue #22): read the stored mark at render
 * time, and record this completion while you are looking at it.
 *
 * The write is an EFFECT on purpose — `kv.set` re-renders every KV consumer,
 * so writing during render would update the provider while another component
 * renders. A row with no KV provider (render tests, panes mounted outside the
 * context) keeps the session-only behaviour.
 */
export function useDurableCompletionSeen(
  taskId: string,
  tabId: string | undefined,
  completionAt: number | undefined,
  viewing: boolean,
): boolean {
  const kv = useOptionalKV()
  const key = completionSeenKey(taskId, tabId)
  const seen = completionSeenAt(kv, key, completionAt)
  useEffect(() => {
    if (!kv || !viewing || completionAt === undefined || seen) return
    markCompletionSeen(kv, key, completionAt)
  }, [kv, key, completionAt, viewing, seen])
  return seen
}

function useRowCardChrome(row: SidebarRow, shared: SidebarRowCardSharedProps, opts: { mainBranch: string }) {
  const t = useT()
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const task = row.task
  const isCursor = row.flatIndex === shared.cursorIndex
  const isSelected = task.id === shared.selectedId
  const selection = resolveRowSelectionChrome(theme, { cursor: isCursor, selected: isSelected })
  const changes = useChanges(shared, task)
  const activity = shared.engineState?.get(task.id)
  const lifecycle = shared.engineLifecycle?.get(task.id)
  const job = shared.taskJobs?.get(task.id)
  const { mainBranch } = opts
  // Live line-2 cluster width (pin / PR chip / ±stats, each + its 1-cell
  // gap): subtracted from the base budget so a quiet row's branch runs the
  // full rail while a busy row still never collides with its cluster.
  const isMain = task.kind === "main"
  const clusterCells =
    (!isMain && task.pinned === true ? 2 : 0) +
    (!isMain && prCheckChip(task) ? 2 : 0) +
    (changes.added > 0 ? `+${changes.added}`.length + 1 : 0) +
    (changes.deleted > 0 ? `−${changes.deleted}`.length + 1 : 0)
  const subtitleBudget = Math.max(6, shared.subtitleBudget - clusterCells)
  const durableSeen = useDurableCompletionSeen(task.id, undefined, completionStampOf(activity), isSelected)
  const completionSeen = completionSeenFor(task.id, activity?.state, isSelected, undefined, durableSeen)
  // This worktree's transcript facts, read OUTSIDE the memo so the row
  // re-derives when its own mtime moves rather than on every map identity
  // change (the collector republishes the whole map per probe round).
  const transcriptMtime = task.worktreePath ? shared.transcriptActivity?.get(task.worktreePath)?.mtimeMs : undefined
  // Memoized on the real inputs so the 10Hz spinner tick (a fresh `shared`
  // object every render) doesn't re-derive idle rows.
  const baseView = useMemo(() => {
    // Dependency-only invalidation key: rebuild when the language changes —
    // buildSidebarRowView reads the global `t` through the locale store.
    void t
    return buildSidebarRowView({
      task,
      activity,
      lifecycle,
      job,
      ...(transcriptMtime !== undefined ? { transcript: { mtimeMs: transcriptMtime } } : {}),
      spinnerFrame: 0,
      subtitleBudget,
      truncateBranch: truncateBranchLabel,
      mainBranch,
      completionSeen,
    })
  }, [task, activity, lifecycle, job, subtitleBudget, mainBranch, completionSeen, transcriptMtime, t])
  // Frame overlay stays OUTSIDE the memo: non-loading rows come back as the
  // same object and never subscribe, so an idle row does zero per-frame work.
  const frame = useSpinnerFrame(baseView.loading)
  const rowView = withSpinnerFrame(baseView, () => frame)
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
  const t = useT()
  const shared = props.shared
  const task = props.row.task
  useEffect(() => {
    // Dependency-only invalidation key: re-poll on the sidebar's ~2s tick.
    void shared.branchTick
    pollCurrentBranch(task.repo)
  }, [task.repo, shared.branchTick])
  const { theme, isCursor, selection, changes, rowView } = useRowCardChrome(props.row, shared, {
    mainBranch: currentBranch(task.repo),
  })
  // Same tone mapping as a task row: the glyph's COLOR carries state too, so
  // an idle project must not sit on the brand primary while an idle task is
  // muted (owner call 2026-07-30 — one vocabulary for both row kinds).
  const stateColor = toneColor(theme, rowView.tone)

  return (
    <box flexDirection="column" gap={0} paddingBottom={0}>
      <RowBody row={props.row} shared={shared} selection={selection}>
        <RowLine selection={selection}>
          <box flexDirection="row" flexGrow={1} paddingRight={1} gap={0}>
            <text fg={stateColor} attributes={TextAttributes.BOLD} wrapMode="none" width={1} flexShrink={0}>
              {rowView.stateGlyph}
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexGrow={1}>
              {spacedTitle(rowView.titleText, shared.titleBudget)}
            </text>
            {shared.moveMode && isCursor ? (
              <text fg={theme.warning} wrapMode="none">
                {t("tasks.moveChip")}
              </text>
            ) : null}
            <JumpDigit flatIndex={props.row.flatIndex} dim={!isCursor} />
          </box>
        </RowLine>
        <RowLine selection={selection}>
          <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
            <SubtitleText view={rowView} />
            <ChangeStats changes={changes} />
          </box>
        </RowLine>
      </RowBody>
    </box>
  )
}

/**
 * The `ctrl+<digit>` this row answers to, right-stuck on its title line.
 * Printing it is what makes the chord usable at all: the digits follow the
 * VISIBLE order, so under `recent` sort they re-shuffle as you switch —
 * you read the number, you don't remember it. Rows past the ninth show
 * nothing rather than a digit that jumps somewhere else. Keyed on the flat
 * index directly so the tree's rows (no SidebarRow wrapper) share it.
 */
// ponytail: ctrl+<digit> jump chord still works, just no longer printed on the row.
export function JumpDigit(_props: { flatIndex: number; dim: boolean }) {
  return null
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
    // Two-line card + 1-cell spacer between tasks (owner call 2026-07-27,
    // settled after trying herdr's gap-0 density: tasks read better apart).
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
            <JumpDigit flatIndex={props.row.flatIndex} dim={!isCursor} />
          </box>
        </RowLine>
        <RowLine selection={selection}>
          <box flexDirection="row" flexGrow={1} paddingLeft={2} paddingRight={1} gap={1}>
            <SubtitleText view={rowView} />
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
