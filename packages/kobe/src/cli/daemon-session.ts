import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { connectIfRunning, connectOrStartDaemon } from "@sma1lboy/kobe-daemon/client/daemon-process"
import type {
  ChannelName,
  ChannelPayloads,
  DaemonRequestName,
  SubscribeRole,
} from "@sma1lboy/kobe-daemon/daemon/protocol"

export interface DaemonRpc {
  request<T = unknown>(name: DaemonRequestName, payload?: unknown): Promise<T>
  subscribe(opts?: { channels?: readonly ChannelName[]; role?: SubscribeRole }): Promise<unknown>
  onChannel<C extends ChannelName>(channel: C, handler: (payload: ChannelPayloads[C]) => void): () => void
}

export interface DaemonSession {
  readonly client: KobeDaemonClient
  close(): void
}

export interface DaemonSessionOptions {
  readonly mode?: "start" | "require-running"
}

export async function openDaemonSession(opts?: { readonly mode?: "start" }): Promise<DaemonSession>
export async function openDaemonSession(opts: DaemonSessionOptions): Promise<DaemonSession | null>
export async function openDaemonSession(opts: DaemonSessionOptions = {}): Promise<DaemonSession | null> {
  const client = opts.mode === "require-running" ? await connectIfRunning() : await connectOrStartDaemon()
  if (!client) return null
  return { client, close: () => client.close() }
}

export async function withDaemonSession<T>(
  work: (client: KobeDaemonClient | null) => Promise<T>,
  opts: DaemonSessionOptions = {},
): Promise<T> {
  const session = await openDaemonSession(opts)
  try {
    return await work(session?.client ?? null)
  } finally {
    session?.close()
  }
}
