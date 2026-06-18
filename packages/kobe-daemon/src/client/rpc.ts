import type { DaemonRequestName } from "../daemon/protocol.ts"

/**
 * Minimal daemon RPC seam.
 *
 * The socket client, daemon-internal direct adapter, and browser HTTP adapter
 * all satisfy this interface. Streaming/subscription lifecycle stays on each
 * transport; callers that only need request/response should depend on this.
 */
export interface DaemonRpcClient {
  request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T>
}

/** Browser HTTP `/api/rpc` envelope. Socket transport uses daemon frames
 * directly, but the success/error shape is intentionally equivalent. */
export interface DaemonRpcHttpResponse<T = unknown> {
  result?: T
  error?: string
  name?: string
}
