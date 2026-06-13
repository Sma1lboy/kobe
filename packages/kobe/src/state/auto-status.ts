/**
 * The "auto status flow" opt-in (docs/design/web-kanban.md M5, revised
 * 2026-06-11): one switch gates BOTH halves of the flow —
 *
 *   - daemon rule: `turn-start` on a backlog task → `in_progress`
 *     (monitor/status-rules.ts), and
 *   - spawn-time system-prompt injection telling the agent to self-report
 *     `in_review` when its work is done (engine/interactive-command.ts
 *     `withStatusProtocol`).
 *
 * Lives in the shared state.json (the Settings dialog's KV writes the same
 * file), read fresh at each decision point so toggling needs no daemon
 * restart. Off by default — the `experimental.` prefix follows the
 * remote-projects precedent.
 */

import { loadStateFile } from "./store.ts"

export const AUTO_STATUS_KEY = "experimental.autoStatus"

export function autoStatusEnabled(): boolean {
  return loadStateFile()[AUTO_STATUS_KEY] === true
}
