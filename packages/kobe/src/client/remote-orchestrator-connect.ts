import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { logClient } from "@sma1lboy/kobe-daemon/client/client-log"
import {
  type ChannelName,
  DAEMON_PROTOCOL_VERSION,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  type SerializedTask,
  type SubscribeRole,
  isProtocolCompatible,
} from "@sma1lboy/kobe-daemon/daemon/protocol"
import { type OrchestratorSignals, deserializeTask } from "./remote-orchestrator-payloads.ts"

export interface PerformInitOptions {
  readonly role: SubscribeRole
  readonly channels?: readonly ChannelName[]
  readonly subscribesTasks: boolean
}

export async function performInit(
  client: KobeDaemonClient,
  opts: PerformInitOptions,
  signals: OrchestratorSignals,
): Promise<void> {
  const hello = await client.request<{
    tasks?: SerializedTask[]
    protocolVersion?: number
    minProtocolVersion?: number
    kobeVersion?: string
    capabilities?: readonly string[]
  }>("hello", {
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    minProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
  })
  const daemonVersion = typeof hello.protocolVersion === "number" ? hello.protocolVersion : DAEMON_PROTOCOL_VERSION
  const daemonMin = typeof hello.minProtocolVersion === "number" ? hello.minProtocolVersion : daemonVersion
  if (
    !isProtocolCompatible({
      localVersion: DAEMON_PROTOCOL_VERSION,
      localMin: MIN_COMPATIBLE_PROTOCOL_VERSION,
      remoteVersion: daemonVersion,
      remoteMin: daemonMin,
    })
  ) {
    throw new Error(
      `kobe daemon is protocol v${daemonVersion} (min v${daemonMin}); this client is v${DAEMON_PROTOCOL_VERSION} (min v${MIN_COMPATIBLE_PROTOCOL_VERSION}). Restart the daemon (\`kobe daemon restart\`) or upgrade kobe.`,
    )
  }
  signals.setDaemonVersionSig(typeof hello.kobeVersion === "string" ? hello.kobeVersion : null)
  if (hello.tasks && opts.subscribesTasks) signals.setTasks(hello.tasks.map(deserializeTask))
  await client.subscribe({ role: opts.role, channels: opts.channels })
  if (hello.capabilities?.includes("worktree.changes")) {
    if (signals.worktreeChangesAcc() === null) signals.setWorktreeChangesSig(new Map())
  } else {
    signals.setWorktreeChangesSig(null)
  }
  if (hello.capabilities?.includes("transcript.activity")) {
    if (signals.transcriptActivityAcc() === null) signals.setTranscriptActivitySig(new Map())
  } else {
    signals.setTranscriptActivitySig(null)
  }
  signals.setConnectionState("online")
  logClient("orch", `subscribed as ${opts.role} (${signals.tasksAcc().length} tasks)`)
}
