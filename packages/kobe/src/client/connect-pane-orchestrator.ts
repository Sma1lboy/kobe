import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { logClient, logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import type { ChannelName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { RemoteOrchestrator, type RemoteOrchestratorOptions } from "./remote-orchestrator.ts"

export interface ConnectPaneOrchestratorOptions {
  readonly logTag?: string
  readonly channels?: readonly ChannelName[]
  readonly connect?: () => Promise<KobeDaemonClient | null>
  readonly orchestratorOptions?: Omit<RemoteOrchestratorOptions, "channels">
}

export async function connectPaneOrchestrator(
  options: ConnectPaneOrchestratorOptions = {},
): Promise<RemoteOrchestrator | null> {
  const tag = options.logTag ?? "orch-connect"
  const connect = options.connect ?? connectIfRunning
  let remote: RemoteOrchestrator | null = null
  try {
    const client = await connect()
    if (!client) {
      logClient(tag, "no daemon running — caller degrades")
      return null
    }
    remote = new RemoteOrchestrator(client, {
      ...options.orchestratorOptions,
      channels: options.channels,
    })
    await remote.init()
    return remote
  } catch (err) {
    logClientError(tag, err)
    remote?.dispose()
    return null
  }
}
