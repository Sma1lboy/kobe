import { errorMessage } from "@/lib/error-message"

export type InboxRpcAction = "mark read" | "dismiss"

export function notifyInboxRpcFailure(
  request: Promise<unknown>,
  action: InboxRpcAction,
  notifyError: (message: string) => void,
): void {
  void request.catch((err) => notifyError(`Couldn't ${action}: ${errorMessage(err)}`))
}
