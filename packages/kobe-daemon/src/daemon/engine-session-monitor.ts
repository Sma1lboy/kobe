/** Continuously maps a tab-owned engine process to its active native context. */

import type { DaemonActivityRegistry } from "./activity-registry.ts"
import type { DaemonOrchestrator, VendorId } from "./contracts.ts"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"
import type { SessionBindingStore } from "./session-bindings.ts"

export interface EngineProcessWatch {
  readonly taskId: string
  readonly tabId: string
  readonly vendor: VendorId
  readonly rootPid: number
  readonly startedAt: number
}

interface WatchState extends EngineProcessWatch {
  generation: number
  cursor?: string
  leaseAt: number
  inFlight: boolean
}

export interface EngineSessionMonitorOptions {
  readonly pollMs?: number
  readonly leaseMs?: number
  readonly now?: () => number
  readonly setIntervalFn?: typeof setInterval
  readonly clearIntervalFn?: typeof clearInterval
}

function keyOf(value: Pick<EngineProcessWatch, "taskId" | "tabId">): string {
  return `${value.taskId}\0${value.tabId}`
}

export class EngineSessionMonitor {
  private readonly watches = new Map<string, WatchState>()
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly timer: ReturnType<typeof setInterval>

  constructor(
    private readonly orch: Pick<DaemonOrchestrator, "getTask">,
    private readonly runtime: Pick<DaemonRuntimeAdapter, "observeEngineSessionActivation">,
    private readonly bindings: Pick<SessionBindingStore, "bind" | "markTransition">,
    private readonly activity: Pick<DaemonActivityRegistry, "pinTabSession">,
    options: EngineSessionMonitorOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.leaseMs = options.leaseMs ?? 15_000
    const setIntervalFn = options.setIntervalFn ?? setInterval
    this.timer = setIntervalFn(() => void this.tick(), options.pollMs ?? 350)
    this.timer.unref?.()
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval
  }

  private readonly clearIntervalFn: typeof clearInterval

  watch(input: EngineProcessWatch): void {
    const key = keyOf(input)
    const current = this.watches.get(key)
    if (current && input.startedAt < current.startedAt) return
    if (
      current?.rootPid === input.rootPid &&
      current.vendor === input.vendor &&
      current.startedAt === input.startedAt
    ) {
      current.leaseAt = this.now()
      return
    }
    this.watches.set(key, {
      ...input,
      generation: (current?.generation ?? 0) + 1,
      leaseAt: this.now(),
      inFlight: false,
    })
    void this.check(key)
  }

  unwatch(input: Pick<EngineProcessWatch, "taskId" | "tabId" | "rootPid">): boolean {
    const key = keyOf(input)
    const current = this.watches.get(key)
    if (!current || current.rootPid !== input.rootPid) return false
    return this.watches.delete(key)
  }

  async tick(): Promise<void> {
    const now = this.now()
    const checks: Promise<void>[] = []
    for (const [key, watch] of this.watches) {
      if (now - watch.leaseAt > this.leaseMs) {
        this.watches.delete(key)
        continue
      }
      checks.push(this.check(key))
    }
    await Promise.all(checks)
  }

  close(): void {
    this.clearIntervalFn(this.timer)
    this.watches.clear()
  }

  size(): number {
    return this.watches.size
  }

  private async check(key: string): Promise<void> {
    const watch = this.watches.get(key)
    if (!watch || watch.inFlight) return
    watch.inFlight = true
    const generation = watch.generation
    try {
      if (!this.orch.getTask(watch.taskId)) {
        this.watches.delete(key)
        return
      }
      const activation = await this.runtime.observeEngineSessionActivation(
        watch.vendor,
        watch.rootPid,
        watch.startedAt,
        watch.cursor,
      )
      const current = this.watches.get(key)
      if (!activation || current !== watch || current.generation !== generation) return
      if (activation.phase === "pending") {
        current.cursor = activation.cursor
        this.bindings.markTransition({
          taskId: watch.taskId,
          tabId: watch.tabId,
          vendor: watch.vendor,
          startSource: activation.source,
          observedAt: activation.observedAt,
        })
        return
      }
      await this.bindings.bind({
        taskId: watch.taskId,
        tabId: watch.tabId,
        vendor: watch.vendor,
        sessionId: activation.sessionId,
        source: "observer",
        startSource: activation.source,
        ...(activation.transcriptPath ? { transcriptPath: activation.transcriptPath } : {}),
      })
      if (this.watches.get(key) === watch) {
        watch.cursor = activation.cursor
        this.activity.pinTabSession(watch.taskId, watch.tabId, activation.sessionId)
      }
    } catch (error) {
      logDaemonError("engine-session-monitor", error)
    } finally {
      const current = this.watches.get(key)
      if (current === watch) current.inFlight = false
    }
  }
}
