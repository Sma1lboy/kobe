import { logDaemonInfo } from "./crash-log.ts"

export interface LifetimeClient {
  readonly subscribed: boolean
  readonly holdsLifetime: boolean
}

export type ScheduleFn = (fn: () => void, ms: number) => () => void

const defaultSchedule: ScheduleFn = (fn, ms) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return () => clearTimeout(t)
}

export interface DaemonLifetimeOptions {
  readonly clients: () => Iterable<LifetimeClient>
  readonly idleGraceMs: number
  readonly onIdleStop: () => void
  readonly schedule?: ScheduleFn
  readonly log?: (event: string, message: string) => void
}

export class DaemonLifetime {
  private readonly clients: () => Iterable<LifetimeClient>
  private readonly idleGraceMs: number
  private readonly onIdleStop: () => void
  private readonly schedule: ScheduleFn
  private readonly log: (event: string, message: string) => void
  private cancelIdle: (() => void) | null = null
  private stopping = false

  constructor(options: DaemonLifetimeOptions) {
    this.clients = options.clients
    this.idleGraceMs = options.idleGraceMs
    this.onIdleStop = options.onIdleStop
    this.schedule = options.schedule ?? defaultSchedule
    this.log = options.log ?? logDaemonInfo
  }

  guiCount(): number {
    let n = 0
    for (const c of this.clients()) if (c.holdsLifetime) n++
    return n
  }

  hasSubscribers(): boolean {
    for (const c of this.clients()) if (c.subscribed) return true
    return false
  }

  isStopping(): boolean {
    return this.stopping
  }

  markStopping(): void {
    this.stopping = true
    this.clearIdle()
  }

  guiAttached(): void {
    this.clearIdle()
  }

  clientDisconnected(wasGui: boolean): void {
    if (wasGui) this.maybeArm()
  }

  private clearIdle(): void {
    if (this.cancelIdle) {
      this.cancelIdle()
      this.cancelIdle = null
    }
  }

  private maybeArm(): void {
    if (this.stopping || this.guiCount() > 0) return
    this.clearIdle()
    this.log("idle", `last gui gone — arming ${this.idleGraceMs}ms idle-stop grace`)
    this.cancelIdle = this.schedule(() => {
      this.cancelIdle = null
      if (this.stopping || this.guiCount() > 0) return
      this.log("idle", "grace elapsed with no gui — self-stopping")
      this.onIdleStop()
    }, this.idleGraceMs)
  }
}
