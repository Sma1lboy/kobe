/**
 * Pure view model for the story drawer's EVENTS feed — the daemon's
 * per-task engine lifecycle ring (`task.recentEvents`,
 * docs/design/plugin-events.md) turned into dense one-line rows.
 *
 * Event kinds and vendor ids stay RAW: they are the engine's own
 * identifiers (like tool names), not UI copy, so they don't go through
 * i18n. Only the section's chrome does.
 */

import type { RecentTaskEvent } from "../../client/remote-orchestrator"
import { relativeAgeMs } from "../../tui/history/message-core"
import { truncateEnd } from "../../tui/lib/truncate"

/** Rows the drawer shows — the tail of the ring, not the whole 100. */
export const EVENT_FEED_LIMIT = 12

/** Detail fragments are labels, not prose: clip the rare long one. */
const FRAGMENT_MAX = 40

export interface EventRow {
  readonly key: string
  /** Relative age ("3m", "2h") — right-aligned by the renderer. */
  readonly age: string
  readonly kind: string
  /** Detail fragment + vendor joined ("Bash · claude"); "" when neither. */
  readonly tail: string
}

function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * The one fragment of an event's detail worth a row: the tool name, the
 * compaction trigger, the subagent type — first hit wins, then the free-form
 * note. "" when the event carries none (`turn-start` and friends).
 */
export function detailFragment(event: RecentTaskEvent): string {
  const detail = event.detail
  if (!detail) return ""
  const tool = detail.tool as { name?: unknown } | undefined
  const compact = detail.compact as { trigger?: unknown } | undefined
  const subagent = detail.subagent as { type?: unknown } | undefined
  const fragment = str(tool?.name) || str(compact?.trigger) || str(subagent?.type) || str(detail.note)
  return truncateEnd(fragment, FRAGMENT_MAX)
}

/**
 * The tail of the ring (which arrives newest LAST), rendered newest FIRST:
 * a tall drawer clips at the card's max height, and losing the oldest rows
 * off the bottom beats losing the ones the user opened the story for.
 */
export function eventRows(
  events: readonly RecentTaskEvent[],
  nowMs: number,
  limit: number = EVENT_FEED_LIMIT,
): readonly EventRow[] {
  return events
    .slice(-limit)
    .reverse()
    .map((event, index) => {
      const tail = [detailFragment(event), str(event.vendor)].filter((part) => part.length > 0)
      return {
        key: `${event.at}:${index}`,
        age: relativeAgeMs(event.at, nowMs),
        kind: event.kind,
        tail: tail.join(" · "),
      }
    })
}
