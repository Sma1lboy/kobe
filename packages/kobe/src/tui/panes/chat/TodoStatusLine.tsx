/**
 * Todo-status panel — pinned directly above the chat composer, shows
 * the current task-tracking snapshot (verbose header + per-task list,
 * always expanded — matches Claude Code's TaskListV2 `isStandalone`
 * mode rather than the collapsible `ctrl+t` panel).
 *
 * Data source: the most-recent task-snapshot tool row in the transcript
 * — `TodoWrite` (v1, list on input) or `TaskList` (v2, list on output).
 * The chat-stream renderer (`ToolRow`'s `TodoSnapshotBody`) shows the
 * same data inline so users can scroll back through historical
 * snapshots; this panel is the "current plan" indicator that doesn't
 * scroll away.
 *
 * Self-hides when:
 *   - the transcript has no snapshot yet,
 *   - the snapshot is empty (v1 TodoWrite cleared its store when every
 *     item completed — `TodoWriteTool.ts:70` `allDone ? [] : todos`),
 *   - or the plan is all-done and the {@link ALL_DONE_GRACE_MS} grace
 *     window has elapsed (mirrors Claude Code's recent-completed TTL).
 */

import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { useTheme } from "../../context/theme"
import type { ChatRow } from "./store"
import { type SnapshotItem, TODO_GLYPH, type TaskStatus, countTodos } from "./todo-render"

export interface TodoStatusLineProps {
  /**
   * Kept on the props even though the panel only reads `roundedSnapshots`
   * directly — `messages` is the cheapest way to make the reactive memo
   * here re-run when chat rows change without sharing a separate
   * "latest snapshot index" signal across the tree.
   */
  readonly messages: readonly ChatRow[]
  /**
   * Per-row "rounded" snapshot items computed once at the ChatView level
   * (see {@link computeRoundedSnapshots}). The panel displays the
   * **last** entry — i.e. the current round's tasks, with older rounds
   * already filtered out.
   */
  readonly roundedSnapshots: ReadonlyMap<number, readonly SnapshotItem[]>
}

/**
 * Grace window after the plan goes all-done before the panel hides
 * itself. Matches Claude Code's `HIDE_DELAY_MS = 5_000` in
 * `refs/claude-code/src/hooks/useTasksV2.ts:16` — the actual "clear the
 * panel" delay. (CC's other 30s constant, `RECENT_COMPLETED_TTL_MS`, is
 * for *visual ordering* of recently completed tasks, not for hiding.)
 */
const ALL_DONE_GRACE_MS = 5_000

export function TodoStatusLine(props: TodoStatusLineProps) {
  const { theme } = useTheme()

  // Current-round items = the last entry in the rounded-snapshots map
  // (newest snapshot row). The cross-row baseline pass already
  // filtered out previous rounds' completed tasks, so what comes out
  // here is "this round only" — same shape CC's `useTasksV2` returns
  // after `resetTaskList` fires.
  const items = createMemo<readonly SnapshotItem[]>(() => {
    // Force reactivity on messages (the map is recomputed from it at
    // the ChatView level, but accessing `props.roundedSnapshots`
    // directly under Solid's tracking is enough; the messages read is
    // belt-and-braces in case ChatView passes a stable map reference).
    void props.messages
    const snapshots = props.roundedSnapshots
    let latest: readonly SnapshotItem[] = []
    for (const entry of snapshots.values()) latest = entry
    return latest
  })

  // True when the round has tasks but every one is completed/deleted.
  const allDone = createMemo<boolean>(() => {
    const list = items()
    if (list.length === 0) return false
    return list.every((t) => t.status === "completed" || t.status === "deleted")
  })

  // 5s grace timer — when `allDone` flips to true, hide the panel
  // after the window elapses. If the round regains work (a new
  // pending / in_progress task) before then, `allDone` flips back and
  // `onCleanup` cancels the timer so the panel stays visible.
  const [graceExpired, setGraceExpired] = createSignal(false)
  createEffect(() => {
    if (!allDone()) {
      setGraceExpired(false)
      return
    }
    setGraceExpired(false)
    const handle = setTimeout(() => setGraceExpired(true), ALL_DONE_GRACE_MS)
    onCleanup(() => clearTimeout(handle))
  })

  const visible = () => items().length > 0 && !(allDone() && graceExpired())

  // Stable id-asc ordering — `[...tasks].sort(byIdAsc)` from CC's
  // TaskListV2.tsx:167 for the un-truncated case (kobe terminal rows
  // usually exceed CC's `maxDisplay=10`, so priority sort + truncation
  // isn't needed yet).
  const sortedItems = createMemo<readonly SnapshotItem[]>(() => {
    return [...items()].sort((a, b) => {
      const an = Number.parseInt(a.key, 10)
      const bn = Number.parseInt(b.key, 10)
      if (!Number.isNaN(an) && !Number.isNaN(bn)) return an - bn
      return a.key.localeCompare(b.key)
    })
  })

  // Status counts for the header — mirrors CC TaskListV2.tsx:129-131
  // (`inProgressCount = tasks.length - completedCount - pendingCount`).
  const counts = createMemo(() => countTodos(items()))

  // Strip the `subject [#id]` decoration that the chat-stream snapshot
  // body adds — panel mode (this surface) keeps the subject clean like
  // CC's TaskItem; the in-chat surface keeps `[#id]` because it helps
  // users tie a row back to a later `TaskUpdate #N` event.
  const cleanText = (item: SnapshotItem): string => item.displayText.replace(/\s+\[#[^\]]+\]\s*$/, "")

  // CC's icon colors (refs/claude-code/src/components/TaskListV2.tsx:225-239):
  //   completed → success ; in_progress → "claude" (no kobe theme key,
  //   fall back to accent) ; pending → undefined (default text color).
  const iconColor = (status: TaskStatus) =>
    status === "completed"
      ? theme.success
      : status === "in_progress"
        ? theme.accent
        : status === "deleted"
          ? theme.error
          : theme.text

  // Subject attribute combo, lifted from CC's TaskItem (line 313):
  //   `<Text bold={isInProgress} strikethrough={isCompleted} dimColor={isCompleted || isBlocked}>`.
  // kobe doesn't track `blockedBy` on SnapshotItem yet so the blocked
  // branch is just "deleted" for now (also dim+strike).
  const subjectAttrs = (status: TaskStatus) => {
    if (status === "completed" || status === "deleted") return TextAttributes.DIM | TextAttributes.STRIKETHROUGH
    if (status === "in_progress") return TextAttributes.BOLD
    return TextAttributes.NONE
  }

  return (
    <Show when={visible()}>
      {/* CC's TaskListV2 isStandalone wrapper: `flexDirection="column"
          marginTop={1} marginLeft={2}`. opentui takes `paddingTop` /
          `paddingLeft` instead of margin* — same visual effect since
          the parent has no background. */}
      <box flexDirection="column" flexShrink={0} paddingLeft={2} paddingTop={1}>
        {/* Header — mirrors CC TaskListV2.tsx:192-208. Numbers bold,
            rest dim. The "in progress" segment is omitted when
            `inProgressCount === 0` so an all-done-or-pending plan reads
            "3 tasks (0 done, 3 open)" (no stray ", 0 in progress,"). */}
        <text fg={theme.textMuted}>
          <span style={{ attributes: TextAttributes.BOLD }}>{counts().total}</span>
          {" tasks ("}
          <span style={{ attributes: TextAttributes.BOLD }}>{counts().done}</span>
          {" done, "}
          <Show when={counts().inProgress > 0}>
            <span style={{ attributes: TextAttributes.BOLD }}>{counts().inProgress}</span>
            {" in progress, "}
          </Show>
          <span style={{ attributes: TextAttributes.BOLD }}>{counts().pending}</span>
          {" open)"}
        </text>
        <For each={sortedItems()}>
          {(t) => (
            <box flexDirection="row" gap={1}>
              <box width={1} height={1}>
                <text fg={iconColor(t.status)}>{TODO_GLYPH[t.status]}</text>
              </box>
              <box flexGrow={1}>
                <text
                  fg={t.status === "pending" ? theme.text : iconColor(t.status)}
                  attributes={subjectAttrs(t.status)}
                >
                  {cleanText(t)}
                </text>
              </box>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}
