/**
 * PtyLiveHold — a keep-alive source for `DaemonLifetime`: "the standalone
 * PTY host still owns at least one live session".
 *
 * Why it exists: the daemon is the only collector of `kobe hook` activity
 * events, and hooks deliberately never spawn a daemon (`hook-cmd.ts`). Before
 * this hold, the last gui detaching idle-stopped the daemon while hosted
 * engines kept running in the pty host — every event they fired during the
 * gap was dropped, and the in-memory activity registry (never persisted)
 * came back empty, blanking the running/attention dots until the next turn
 * boundary. Holding the daemon open while sessions live keeps the event
 * stream unbroken, which is the whole accuracy story for the dots.
 *
 * Shape mirrors the automations keep-alive: `DaemonLifetime` reads a sync
 * `isHeld()` at its arm/fire points, and the true→false transition calls
 * `onRelease` (wired to `lifetime.reevaluateIdle()`) — the same hole-plug
 * automations need when their last schedule is deleted. Because the pty host
 * is a separate process, the cached flag is refreshed by polling its socket:
 * a slow interval for the steady state, plus `probeSoon()` on gui disconnect
 * so the idle-grace recheck reads a fresh value instead of a poll-stale one.
 * The probe never spawns a host; unreachable reads as "no live sessions".
 */

import { logDaemonInfo } from "./crash-log.ts"

/** Steady-state poll cadence. Freshness at the moments that matter comes from
 *  `probeSoon()`, so this only bounds how long a gui-less daemon outlives its
 *  last engine session. */
const DEFAULT_POLL_MS = 15_000

export interface PtyLiveHoldOptions {
  /** Asks the pty host for live sessions. Must resolve false when the host
   *  is unreachable and never spawn one (`ptyHostHasLiveSessions`). */
  readonly probe: () => Promise<boolean>
  /** Fired once per held→released transition; wire to `reevaluateIdle()`. */
  readonly onRelease: () => void
  readonly pollMs?: number
  /** Structured log sink (default: {@link logDaemonInfo}); injected by tests. */
  readonly log?: (event: string, message: string) => void
}

export class PtyLiveHold {
  private readonly probe: () => Promise<boolean>
  private readonly onRelease: () => void
  private readonly pollMs: number
  private readonly log: (event: string, message: string) => void
  private held = false
  private inFlight: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(options: PtyLiveHoldOptions) {
    this.probe = options.probe
    this.onRelease = options.onRelease
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.log = options.log ?? logDaemonInfo
  }

  /** Begin the initial probe and the steady-state poll. */
  start(): void {
    void this.probeSoon()
    this.timer = setInterval(() => void this.probeSoon(), this.pollMs)
    this.timer.unref?.()
  }

  /** Cached answer — sync, read by `DaemonLifetime.keepAlive`. */
  isHeld(): boolean {
    return this.held
  }

  /** Refresh the cache now (deduped against an in-flight probe). Called on
   *  gui disconnect so the idle-grace decision doesn't read a stale poll. */
  probeSoon(): Promise<void> {
    this.inFlight ??= this.refresh().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async refresh(): Promise<void> {
    let next: boolean
    try {
      next = await this.probe()
    } catch {
      return // probe contract is throw-free; on a bug, keep the last answer
    }
    if (next === this.held) return
    this.held = next
    this.log("idle", next ? "pty host has live sessions — holding daemon open" : "last live pty session gone")
    if (!next) this.onRelease()
  }
}
