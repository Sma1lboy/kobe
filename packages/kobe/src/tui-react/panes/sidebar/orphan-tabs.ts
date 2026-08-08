/**
 * Backstop for tab rows the KV snapshot doesn't know about.
 *
 * The tree's primary source is the task's persisted tab snapshot, written by
 * a mounting `TerminalTabs` and (since the CLI fix) by the headless launch
 * path. But a snapshot is a RECORD of intent, while the pty host holds the
 * truth about what is actually running — and the two can disagree:
 *
 *   - a session started by an older kobe, before the CLI wrote snapshots;
 *   - a snapshot reclaimed by the orphan sweep while its PTY lived on;
 *   - anything that opens a `<taskId>::<tabId>` session without going
 *     through either writer.
 *
 * In every one of those the engine is alive and the sidebar showed the
 * worktree with nothing under it. So: derive rows from live sessions for
 * tasks the snapshot has no answer for. Snapshot wins whenever it HAS one —
 * it carries titles, ordinals, kinds and split state that a session key
 * can't, and a live session is only ever used to fill a hole.
 */

import { type TreeTab, parseRowId } from "../../../tui/panes/sidebar/tree-core"

/** One live pty-host session, as this module needs it. */
export interface LiveSession {
  readonly key: string
  readonly alive?: boolean
  /** OSC window title of the live process, when the host observed one. */
  readonly title?: string | null
}

/**
 * Group live sessions into tab projections per task, skipping every task in
 * `known` (the snapshot already answered for those).
 *
 * The label is the live process title when the host has one, else the tab
 * id — a headless `<taskId>::tab-1` has no recorded title anywhere, and
 * showing the id beats showing a row with no name.
 */
export function orphanTabsByTask(
  sessions: readonly LiveSession[],
  known: ReadonlySet<string>,
): Map<string, readonly TreeTab[]> {
  const byTask = new Map<string, TreeTab[]>()
  for (const session of sessions) {
    if (session.alive === false) continue
    // A pty key IS a tab row id (`<taskId>::<tabId>`) — same separator, same
    // parse rule, so the two can never disagree about what a key means.
    const { taskId, tabId } = parseRowId(session.key)
    if (!tabId || known.has(taskId)) continue
    const tabs = byTask.get(taskId) ?? []
    tabs.push({
      id: tabId,
      label: session.title?.trim() || tabId,
      // The sole tab of an orphaned task is necessarily its active one.
      active: tabs.length === 0,
      // Assume engine: the headless launch path only ever starts engines,
      // and the state glyph is the reason these rows are worth showing.
      engine: true,
    })
    byTask.set(taskId, tabs)
  }
  return byTask
}
