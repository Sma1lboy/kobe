import type { AttentionInboxItem } from "../../client/remote-orchestrator"
import { notifyInboxRpcFailure } from "./inbox-rpc-errors"

type InboxOpenRpc = {
  markAttentionRead(taskId: string, tabId: string | null, at: number): Promise<unknown>
  dismissAttention(taskId: string, tabId: string | null, at: number): Promise<unknown>
}

/** Mark a live item read; an unavailable item is stale UI state and is dismissed instead. */
export function requestInboxItemOpen(
  item: AttentionInboxItem,
  available: boolean,
  rpc: InboxOpenRpc,
  notifyError: (message: string) => void,
): boolean {
  const request = available
    ? rpc.markAttentionRead(item.taskId, item.tabId, item.at)
    : rpc.dismissAttention(item.taskId, item.tabId, item.at)
  notifyInboxRpcFailure(request, available ? "mark read" : "dismiss", notifyError)
  return available
}
