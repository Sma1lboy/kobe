import type { AttentionInboxItem, RemoteOrchestrator } from "../../client/remote-orchestrator"
import { notifyInboxRpcFailure } from "./inbox-rpc-errors"

type InboxOpenRpc = Pick<RemoteOrchestrator, "dismissAttention">

/**
 * Opening an item RESOLVES it: the item is removed from the Inbox
 * (no read/unread lifecycle — owner call 2026-07-16). A fresh event on the
 * same Task and Terminal Tab records a new item at the latest position.
 * Unavailable items are stale UI state and resolve the same way.
 */
export function requestInboxItemOpen(
  item: AttentionInboxItem,
  available: boolean,
  rpc: InboxOpenRpc,
  notifyError: (message: string) => void,
): boolean {
  notifyInboxRpcFailure(rpc.dismissAttention(item.taskId, item.tabId, item.at), "dismiss", notifyError)
  return available
}
