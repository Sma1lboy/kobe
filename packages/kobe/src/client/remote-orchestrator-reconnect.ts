/** Reconnect state machine extracted from RemoteOrchestrator for the file-size cap. */

import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { logClient, logClientError } from "@sma1lboy/kobe-daemon/client/client-log"
import type { SubscribeRole } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { shouldLogReconnectAttempt } from "./remote-orchestrator-payloads.ts"

export class RemoteReconnectController {
  private reconnectTask: Promise<void> | null = null

  constructor(
    private readonly deps: {
      client: KobeDaemonClient
      role: SubscribeRole
      ensureReachable: () => Promise<unknown>
      init: () => Promise<void>
      setDisconnected: () => void
    },
  ) {}

  onClose(): void {
    this.deps.setDisconnected()
    const spawnDaemon = this.deps.role === "gui"
    logClient(
      "orch",
      spawnDaemon
        ? "daemon socket closed — starting silent spawning reconnect loop"
        : "daemon socket closed — starting non-spawning reconnect loop",
    )
    void this.reconnect(spawnDaemon)
  }

  /** A GUI may spawn the daemon; a pane only retries the existing socket. */
  reconnect(spawnDaemon: boolean): Promise<void> {
    if (this.reconnectTask) return this.reconnectTask
    const task = this.run(spawnDaemon)
    this.reconnectTask = task
    const clear = (): void => {
      if (this.reconnectTask === task) this.reconnectTask = null
    }
    task.then(clear, clear)
    return task
  }

  async manualReconnect(): Promise<void> {
    this.deps.client.forceDisconnect()
    await this.reconnect(true)
  }

  private async run(spawnDaemon: boolean): Promise<void> {
    let delayMs = spawnDaemon ? 0 : 500
    let attempt = 0
    while (!this.deps.client.isDisposed) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (this.deps.client.isDisposed) break
      attempt++
      try {
        if (spawnDaemon) await this.deps.ensureReachable()
        await this.deps.init()
        logClient("orch", `reconnected and re-subscribed after ${attempt} attempt(s) — task list re-synced`)
        return
      } catch (err) {
        if (shouldLogReconnectAttempt(attempt)) logClientError("orch-reconnect", err)
        delayMs = delayMs === 0 ? 500 : Math.min(delayMs * 2, 3000)
      }
    }
  }
}
