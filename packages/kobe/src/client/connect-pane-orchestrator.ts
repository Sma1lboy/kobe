/**
 * Shared non-spawning pane-orchestrator connect (KOB — half-built
 * orchestrator leak).
 *
 * Every in-tmux pane host that wants the daemon's push channels opened the
 * SAME three lines: `connectIfRunning()` → `new RemoteOrchestrator(client)`
 * → `await remote.init()`, with a `try/catch` that only logged on failure.
 * That last part was a latent leak: if `init()` throws AFTER the socket
 * opened (a protocol-skew rejection in the compatibility check, the daemon
 * dying mid-handshake, a malformed hello), the half-built orchestrator was
 * abandoned with its socket still open — and the constructor's
 * `role: "pane"` close handler then starts a non-spawning reconnect loop
 * that retries forever and re-subscribes a client NOBODY reads. In a
 * days-lived Tasks pane that's a permanent ghost subscriber receiving (and
 * deserializing) every broadcast.
 *
 * host-boot's UiPrefsSync was hardened against exactly this; this helper is
 * that pattern, once, so the fix can't drift between copies:
 *
 *   - **NON-spawning** — `connectIfRunning()`, never `ensureDaemonReachable`.
 *     A helper pane must never resurrect an idle-stopped daemon (a gui owns
 *     daemon lifetime); no daemon → return `null` and let the caller degrade.
 *   - **dispose-on-failure** — a thrown `init()` disposes the half-built
 *     orchestrator (closing the socket + stopping the would-be reconnect
 *     loop) before returning `null`.
 *
 * The caller still owns the LIVE orchestrator's teardown (`onDestroy` /
 * `onCleanup` → `dispose()`); this helper only guarantees a FAILED connect
 * leaks nothing. A caller with its own component-lifecycle race (a cleanup
 * that can run while this promise is still in flight — UiPrefsSync) wraps
 * the result with a `disposed`-flag check; see host-boot.tsx.
 */

import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { logClient, logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import type { ChannelName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { RemoteOrchestrator, type RemoteOrchestratorOptions } from "./remote-orchestrator.ts"

export interface ConnectPaneOrchestratorOptions {
  /**
   * `[subsystem]` tag for the no-daemon / failure log lines. Pass the
   * caller's own tag so a degrade is attributable (e.g. `"ui-prefs"`,
   * `"tasks-boot"`).
   */
  readonly logTag?: string
  /**
   * Per-channel subscribe filter, forwarded to {@link RemoteOrchestrator}.
   * Omit for every channel (a primary orchestrator); pass a narrow set for
   * a single-purpose consumer (UiPrefsSync → `["ui-prefs", "keybindings"]`).
   */
  readonly channels?: readonly ChannelName[]
  /**
   * Inject the connect step (tests supply a fake client / null without a
   * real socket). Defaults to the non-spawning {@link connectIfRunning}.
   */
  readonly connect?: () => Promise<KobeDaemonClient | null>
  /** Extra {@link RemoteOrchestrator} options (role, ensureReachable). */
  readonly orchestratorOptions?: Omit<RemoteOrchestratorOptions, "channels">
}

/**
 * Open a non-spawning daemon subscription as a pane orchestrator. Returns
 * the live {@link RemoteOrchestrator} on success, or `null` when no daemon
 * is running OR the handshake failed (the half-built orchestrator is
 * disposed before returning, so a failure never leaks the socket or arms a
 * consumer-less reconnect loop). Never throws.
 */
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
    // A failed init() after the socket opened must DISPOSE the half-built
    // orchestrator — abandoning it leaks the open socket plus the pane
    // reconnect loop that would retry forever with no consumer.
    remote?.dispose()
    return null
  }
}
