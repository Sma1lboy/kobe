/**
 * DaemonLifetime — the daemon's "should I still be running, and should my
 * collectors?" policy, extracted from `server.ts` into one testable seam.
 * (Distinct from `lifecycle.ts`, which kills an EXTERNAL daemon process.)
 *
 * Three interdependent rules live here instead of as loose functions + a
 * shared `stopping` flag scattered across the server closure (`guiCount`,
 * `hasSubscribers`, `cancelIdleTimer`, `maybeArmIdleShutdown`, and the timer
 * callback). They are really ONE policy keyed on which front-ends are attached:
 *
 *  1. **Lazy shutdown** — the daemon's lifetime is bound to attached GUIs
 *     (`role: "gui"` subscribers — the `holdsLifetime` flag). When the LAST gui
 *     disconnects we wait a short grace, then self-stop. We arm only on a
 *     >0 → 0 gui transition (never on boot), so a deliberately gui-less
 *     `kobe daemon start` / freshly-respawned `daemon restart` stays up. A gui
 *     (re)attach cancels a pending grace; a pane subscribing during the grace
 *     must NOT.
 *  2. **Collector gate** — the background collectors (worktree-changes,
 *     auto-title) exist to feed an attached pane, so they pause while there are
 *     zero subscribers (gui OR pane) and resume once one subscribes.
 *  3. **Stopping** — once teardown begins, neither rule may re-fire.
 *
 * The source of truth stays the server's live `clients` set (passed as a
 * provider), so there is NO counter to drift out of sync with re-subscribes,
 * role changes, or unsubscribed socket closes — the policy just scans it. What
 * this module owns is the timer, the `stopping` flag, and the arm/cancel rules,
 * with an injectable clock so the policy is unit-testable without a real socket
 * or a wall-clock grace.
 */

import { logDaemonInfo } from "./crash-log.ts"

/** The slice of a client the lifetime policy reads. The server's full
 *  `ClientState` satisfies this structurally. */
export interface LifetimeClient {
  readonly subscribed: boolean
  readonly holdsLifetime: boolean
}

/** Schedule `fn` after `ms`; returns a cancel function. The default uses an
 *  unref'd `setTimeout` (so a pending grace never keeps the process alive);
 *  tests inject a manual clock. */
export type ScheduleFn = (fn: () => void, ms: number) => () => void

const defaultSchedule: ScheduleFn = (fn, ms) => {
  const t = setTimeout(fn, ms)
  t.unref?.()
  return () => clearTimeout(t)
}

export interface DaemonLifetimeOptions {
  /** The live set of connected clients — scanned on demand (no cached count). */
  readonly clients: () => Iterable<LifetimeClient>
  /** Grace before a gui-less daemon self-stops. */
  readonly idleGraceMs: number
  /** Invoked once when the grace elapses with still-zero guis. */
  readonly onIdleStop: () => void
  /**
   * When set, arm a BOOT-time grace too: a daemon that never sees a single
   * gui within this window self-stops. For AUTOSPAWNED daemons only
   * (`KOBE_DAEMON_AUTOSPAWNED`, set by `connectOrStartDaemon`'s spawn) —
   * they exist to serve the client that spawned them, and one whose client
   * never attached as a gui otherwise lives FOREVER (the arm-on-transition
   * rule above never fires without a >0 → 0 gui drop; that hole bred the
   * 2026-07-13 zombie daemons holding the prod socket). A deliberate
   * `kobe daemon start` never sets the env flag and keeps the documented
   * stays-up behavior.
   */
  readonly firstGuiGraceMs?: number
  /** Timer factory (default: unref'd setTimeout); injected by tests. */
  readonly schedule?: ScheduleFn
  /** Structured log sink (default: {@link logDaemonInfo}); injected by tests. */
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
    // Autospawned daemons must not outlive a client that never became a
    // gui (see firstGuiGraceMs). The first guiAttached() cancels this;
    // afterwards only the normal >0 → 0 transition arms shutdown.
    const bootGrace = options.firstGuiGraceMs
    if (bootGrace !== undefined) {
      this.log("idle", `autospawned — arming ${bootGrace}ms first-gui grace`)
      this.cancelIdle = this.schedule(() => {
        this.cancelIdle = null
        if (this.stopping || this.guiCount() > 0) return
        this.log("idle", "first-gui grace elapsed with no gui — self-stopping")
        this.onIdleStop()
      }, bootGrace)
    }
  }

  /** Attached GUIs — the refcount that gates lazy shutdown. Counts only
   *  `holdsLifetime` (role "gui") clients, not every subscribed pane. */
  guiCount(): number {
    let n = 0
    for (const c of this.clients()) if (c.holdsLifetime) n++
    return n
  }

  /** Any subscribed consumer (gui OR pane) — the background-collector gate. */
  hasSubscribers(): boolean {
    for (const c of this.clients()) if (c.subscribed) return true
    return false
  }

  /** True once teardown has begun; suppresses any further arm/fire. */
  isStopping(): boolean {
    return this.stopping
  }

  /** Mark teardown as begun and cancel any pending grace. Idempotent. */
  markStopping(): void {
    this.stopping = true
    this.clearIdle()
  }

  /** A gui (re)attached → cancel any pending lazy-shutdown grace. A pane must
   *  NOT call this: panes alone never keep the daemon up, so a pane connecting
   *  during the grace window leaves the countdown running. */
  guiAttached(): void {
    this.clearIdle()
  }

  /** A client disconnected. Only a `holdsLifetime` (gui) drop can arm the
   *  grace — a helper pane or a transient CLI poke leaves the gui count
   *  unchanged, so neither trips shutdown. */
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
