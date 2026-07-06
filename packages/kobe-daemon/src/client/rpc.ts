import type { DaemonRequestName } from "../daemon/protocol.ts"

export interface DaemonRpcClient {
  request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T>
}

export interface DaemonRpcHttpResponse<T = unknown> {
  result?: T
  error?: string
  name?: string
}
