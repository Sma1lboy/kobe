/**
 * The daemon handshake for `RemoteOrchestrator.init()` — split out of
 * `remote-orchestrator.ts` (which was over the repo's 500-line file-size
 * cap) into its own file. Same behavior, moved verbatim: `performInit` is
 * the exact body of the old `RemoteOrchestrator.init`, now taking the
 * client + subscribe options + an explicit {@link OrchestratorSignals}
 * deps bag instead of closing over `this`.
 */

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
  /** `false` when a channel filter excludes `task.snapshot` — skip hello task hydration. */
  readonly subscribesTasks: boolean
}

/** Open the daemon socket, hello, subscribe to the task snapshot stream. */
export async function performInit(
  client: KobeDaemonClient,
  opts: PerformInitOptions,
  signals: OrchestratorSignals,
): Promise<void> {
  // Send our protocol version so the daemon can reject a mismatch, and
  // verify the daemon's version so an OLD daemon (which predates the
  // server-side check) is caught client-side too — both surface the
  // documented "upgrade your kobe" error instead of cryptic failures.
  const hello = await client.request<{
    tasks?: SerializedTask[]
    protocolVersion?: number
    minProtocolVersion?: number
    // The daemon's BUILD version (package.json). Omitted by a daemon that
    // predates the field, in which case it stays unknown → never "stale".
    // Distinct from the protocol versions above: those gate compatibility,
    // this drives the non-fatal stale-build banner (see daemonStaleSignal).
    kobeVersion?: string
    // The daemon's channel/feature set. The client gates the
    // `worktree.changes` consumer on it (see below) — a capability list
    // is the honest rollout mechanism for an additive channel: an old
    // daemon simply doesn't advertise it, and the pane keeps its local
    // git-polling fallback instead of waiting for pushes that never come.
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
  // Capture the daemon's BUILD version (NON-fatal — the protocol is already
  // compatible). A patch upgrade keeps the protocol version put, so this is
  // the only signal that the daemon is running stale code in memory; the TUI
  // reads `daemonStaleSignal()` to show a "restart the daemon" banner. An old
  // daemon that omits the field leaves the signal null → never flagged stale.
  // Re-set on every init so a reconnect to a freshly-restarted daemon clears
  // the banner once versions match.
  signals.setDaemonVersionSig(typeof hello.kobeVersion === "string" ? hello.kobeVersion : null)
  // Hydrate the task list from `hello` only when this orchestrator actually
  // subscribes to `task.snapshot`. A channel-filtered consumer (UiPrefsSync)
  // that excluded it would otherwise deserialize the whole list into a
  // mirror nothing reads — the exact churn the filter exists to remove.
  if (hello.tasks && opts.subscribesTasks) signals.setTasks(hello.tasks.map(deserializeTask))
  // Subscribe to the daemon's push channels (it replays each channel's
  // current value on connect). Pass `channels` to restrict the fan-out
  // for a narrow consumer (UiPrefsSync), or omit for everything. Pass our
  // role so the daemon's lazy-shutdown refcount counts only real
  // front-end attaches (`gui`), not in-tmux helper panes (`pane`).
  await client.subscribe({ role: opts.role, channels: opts.channels })
  // Daemon-collected worktree changes (issue #6): gate on the hello
  // capability list — the honest "does this daemon run the collector?"
  // signal during a rolling upgrade. A capable daemon replays the
  // channel's last value during subscribe (handled above by handleEvent
  // before this response resolves); when no value was published yet, an
  // EMPTY map (not null) says "daemon collects — trust pushes, spawn no
  // local git". An old daemon without the capability resets the signal
  // to null so the sidebar's local poller engages cleanly — including
  // after a reconnect that downgraded daemons.
  if (hello.capabilities?.includes("worktree.changes")) {
    if (signals.worktreeChangesAcc() === null) signals.setWorktreeChangesSig(new Map())
  } else {
    signals.setWorktreeChangesSig(null)
  }
  // Daemon-collected transcript activity (perf — deduplicate per-Ops-pane
  // polling): same rolling-upgrade gate as `worktree.changes` above. A
  // capable daemon → seed an EMPTY map (not null) so the Ops pane trusts
  // pushes and stops its local mtime/completion probes; an old daemon
  // without the capability resets the signal to null so the pane's local
  // polling engages cleanly — including after a reconnect that downgraded
  // daemons.
  if (hello.capabilities?.includes("transcript.activity")) {
    if (signals.transcriptActivityAcc() === null) signals.setTranscriptActivitySig(new Map())
  } else {
    signals.setTranscriptActivitySig(null)
  }
  signals.setConnectionState("online")
  logClient("orch", `subscribed as ${opts.role} (${signals.tasksAcc().length} tasks)`)
}
