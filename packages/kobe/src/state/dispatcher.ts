/**
 * The dispatcher opt-in (docs/design/dispatcher.md): one switch gates BOTH
 * halves of the conflict-radar dispatcher —
 *
 *   - daemon side: the dispatch feeder forwarding radar digests to each
 *     repo's main-task session (kobe-daemon/src/daemon/dispatch-feeder.ts),
 *   - spawn side: the system-prompt injection that turns a repo's main
 *     session into the dispatcher (engine/interactive-command.ts
 *     `withDispatcherProtocol`).
 *
 * Lives in the shared state.json (the Settings dialog's KV writes the same
 * file), read fresh at each decision point so toggling needs no daemon
 * restart. Off by default — the `experimental.` prefix follows the
 * auto-status/remote-projects precedent.
 */

import { getPersistedBool } from "./store.ts"

export const DISPATCHER_KEY = "experimental.dispatcher"

export function dispatcherEnabled(): boolean {
  return getPersistedBool(DISPATCHER_KEY, false)
}
