/**
 * PendingInputBroker — the per-(Task, ChatTab) bucket of "this tab
 * has a request waiting for the user to respond."
 *
 * Why a seam:
 *   The same conceptual map exists on both sides of the daemon wire.
 *   Inside the Orchestrator the bucket is the source of truth: the
 *   SessionPump records into it when ExitPlanMode / AskUserQuestion
 *   fires, and `respondToInput` pops out of it. Inside a
 *   RemoteOrchestrator the bucket is a replica fed by wire events
 *   (`user_input.request` / `user_input.resolved`) and seeded on
 *   attach via `chat.input.pending`.
 *
 *   Before this seam, the same shape was rebuilt by hand in three
 *   places (Orchestrator's private maps, daemon protocol handlers,
 *   RemoteOrchestrator's `pendingInputs`). Adding a new pause tool
 *   meant threading the wire and both bucket impls in lockstep, and
 *   `peekPendingInput` on the remote silently returned `[]` for ages
 *   because the hydration loop didn't exist yet. One interface, two
 *   adapters, no more drift.
 *
 *   The broker is pure data — it doesn't emit events. Callers
 *   (Orchestrator, RemoteOrchestrator) decide when to dispatch
 *   `user_input.request` / `user_input.resolved` after a mutation.
 *
 * Naming:
 *   The composite `tabKey` field is the orchestrator's per-tab event-
 *   bus key (`${taskId}:${tabId}`). The chat run-state signal joins on
 *   it to paint the "awaiting input" dot on the right ChatTab chip.
 */

import type { UserInputPayload } from "./engine"

export interface PendingInputEntry {
  readonly requestId: string
  readonly payload: UserInputPayload
  /**
   * Composite `${taskId}:${tabId}` of the ChatTab that fired the
   * pause. Now part of the bucket from end to end: the wire snapshot
   * (`chat.input.pending`) echoes it, RemoteOrchestrator hydrates with
   * it, and the broker continues to expose it on `resolve` for
   * routing. Before this field every consumer had to fall back to
   * `task.activeTabId` on attach, which was wrong for pause requests
   * fired against a non-active tab.
   */
  readonly tabKey: string
}

export type ResolvedInputEntry = PendingInputEntry

export interface PendingInputBroker {
  /**
   * Record a fresh pending-input request. The caller supplies the
   * `requestId` (the orchestrator's counter on the local side, the
   * daemon-issued id on the remote side) so both adapters agree on
   * identity without coordinating an allocator.
   *
   * Idempotent on the (taskId, requestId) pair — a second `record`
   * with the same id is a no-op so wire replays from
   * `chat.input.pending` snapshots don't double-count.
   */
  record(taskId: string, tabKey: string, requestId: string, payload: UserInputPayload): void

  /**
   * Drop a pending entry. Returns the dropped payload + the tabKey
   * the request was attributed to, or `null` if the request was
   * unknown (e.g. the user double-clicked Approve and the second
   * call raced past the first).
   */
  resolve(taskId: string, requestId: string): ResolvedInputEntry | null

  /**
   * Snapshot the pending entries for a task in record order
   * (oldest first). Defensive copy — callers may not mutate.
   * Returns an empty array for unknown tasks.
   */
  snapshot(taskId: string): PendingInputEntry[]

  /**
   * Composite tabKeys for every tab currently awaiting input across
   * every task. The Orchestrator joins this against its handles map
   * to build the per-tab `awaiting_input` vs `running` run-state
   * signal — `awaiting_input` wins on overlap.
   */
  awaitingTabKeys(): Iterable<string>

  /**
   * Drop every pending entry for a task. Called by `deleteTask` so
   * the bucket doesn't leak when a task is removed mid-pause.
   */
  clearForTask(taskId: string): void
}
