/**
 * Pure projection logic for the Agents-mode view (KOB-209).
 *
 * Kept renderer-free (no `@opentui/*`, no Solid) so the grouping is
 * unit-testable without booting a terminal. Same split as
 * `center-tab-strip-parts.ts` and `background-tasks-parts.ts`.
 */

import { type ChatRunState, chatRunStateKey } from "@/orchestrator/core"
import type { ChatTab } from "@/types/task"
import type { ChatRow, ChatState } from "./store"

/** State buckets in the order the view renders them (most attention first). */
export const AGENTS_GROUP_ORDER = ["awaiting_input", "running", "idle"] as const
export type AgentsGroup = (typeof AGENTS_GROUP_ORDER)[number]

/** One agent card in the Agents view. */
export interface AgentRow {
  readonly tabId: string
  readonly label: string
  readonly state: AgentsGroup
  /** Short last-message preview; empty string when the tab has no messages. */
  readonly preview: string
  /** True iff this row is the task's currently-active ChatTab. */
  readonly isActive: boolean
}

const PREVIEW_MAX_CHARS = 80

/**
 * Strip newlines + collapse whitespace + cap length so the preview
 * renders on one line. The text comes from raw model output / user
 * input, so it can contain arbitrary control chars and runs.
 */
export function summarizePreview(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim()
  if (collapsed.length <= PREVIEW_MAX_CHARS) return collapsed
  return `${collapsed.slice(0, PREVIEW_MAX_CHARS - 1)}…`
}

/**
 * Pull a one-line preview from a tab's ChatState. Prefers the last
 * assistant row (what the agent most recently said), falls back to the
 * last user row (what the user most recently asked), and returns an
 * empty string for a fresh tab with no messages at all.
 */
export function lastMessagePreview(state: ChatState | undefined): string {
  if (!state) return ""
  const msgs = state.messages
  for (let i = msgs.length - 1; i >= 0; i--) {
    const row: ChatRow | undefined = msgs[i]
    if (!row) continue
    if (row.kind === "assistant" || row.kind === "user") {
      return summarizePreview(row.text)
    }
  }
  return ""
}

/**
 * Project the active task's tabs + run-state map into Agents-view rows.
 *
 * - State is resolved per-tab via `chatRunStateKey(taskId, tab.id)`.
 *   The run-state map only tracks `running` / `awaiting_input`, so any
 *   tab without an entry is `idle` (matches the rest of the codebase).
 * - The active tab is marked `isActive` so the renderer can highlight
 *   it without changing its bucket.
 * - Order within a bucket follows the source `tabs` array (tab seq
 *   order is already stable from the orchestrator).
 */
export function computeAgentRows(
  taskId: string,
  tabs: readonly ChatTab[],
  runState: ReadonlyMap<string, ChatRunState>,
  states: ReadonlyMap<string, ChatState>,
  activeTabId: string | null,
  /**
   * Tabs the caller just dispatched a prompt into but for which the
   * daemon's run-state broadcast hasn't landed yet. Treated as
   * `running` so the new card moves out of IDLE the instant the user
   * submits — engine cold-start + IPC roundtrip can be 1–3s, and
   * watching a fresh agent sit in IDLE for that long reads as a hang.
   * Real run-state entries take priority once they arrive (the caller
   * clears the optimistic set in an effect on the run-state signal).
   */
  optimisticRunning?: ReadonlySet<string>,
): AgentRow[] {
  return tabs.map((tab) => {
    const key = chatRunStateKey(taskId, tab.id)
    const live = runState.get(key)
    const tabState = states.get(tab.id)
    let state: AgentsGroup
    if (live === "awaiting_input") {
      // `awaiting_input` always wins — even if the engine is mid-stream
      // (rare but possible during a tool-loop), the user-facing truth
      // is "waiting on you".
      state = "awaiting_input"
    } else if (live === "running" || tabState?.isStreaming || optimisticRunning?.has(tab.id)) {
      // Three sources of "this tab is working", in priority order:
      //   1. daemon's run-state map (authoritative when fresh)
      //   2. the tab's own ChatState.isStreaming — driven by per-tab
      //      events, immune to the brief gap between AskUserQuestion
      //      answer and the resume turn's bumpRunState (see KOB-209
      //      followup; `respondToInput` clears the handle, calls
      //      bumpRunState, THEN awaits runTask which re-registers a
      //      handle — without this fallback the card flickers IDLE).
      //   3. optimisticRunning — covers spawn cold-start.
      state = "running"
    } else {
      state = "idle"
    }
    return {
      tabId: tab.id,
      label: tab.title && tab.title.length > 0 ? tab.title : `chat ${tab.seq}`,
      state,
      preview: lastMessagePreview(states.get(tab.id)),
      isActive: tab.id === activeTabId,
    }
  })
}

/**
 * Group rows by bucket in `AGENTS_GROUP_ORDER`. Empty buckets are
 * omitted so the renderer doesn't have to short-circuit.
 */
export function groupAgentRows(rows: readonly AgentRow[]): { group: AgentsGroup; rows: AgentRow[] }[] {
  const out: { group: AgentsGroup; rows: AgentRow[] }[] = []
  for (const group of AGENTS_GROUP_ORDER) {
    const bucket = rows.filter((r) => r.state === group)
    if (bucket.length > 0) out.push({ group, rows: bucket })
  }
  return out
}

/** Human-facing section header for each bucket. */
export function agentsGroupLabel(group: AgentsGroup): string {
  if (group === "awaiting_input") return "awaiting input"
  if (group === "running") return "running"
  return "idle"
}
