import type {
  DaemonRpcClient,
  DaemonRpcHttpResponse,
} from "@sma1lboy/kobe-daemon/client/rpc"
import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { type ApiRequestOptions, api } from "./api-client.ts"

type PostJson = <T>(
  path: string,
  body?: unknown,
  opts?: ApiRequestOptions,
) => Promise<T>

export interface HttpDaemonRpcClientOptions {
  readonly path?: string
  readonly post?: PostJson
}

export function createHttpDaemonRpcClient(
  opts: HttpDaemonRpcClientOptions = {},
): DaemonRpcClient {
  const path = opts.path ?? "/api/rpc"
  const post = opts.post ?? api.post.bind(api)
  return {
    async request<T = unknown>(
      name: DaemonRequestName,
      payload?: unknown,
    ): Promise<T> {
      const json = await post<DaemonRpcHttpResponse<T>>(
        path,
        { name, payload },
        { label: `rpc ${name}` },
      )
      return json.result as T
    },
  }
}

export const daemonRpc = createHttpDaemonRpcClient()
