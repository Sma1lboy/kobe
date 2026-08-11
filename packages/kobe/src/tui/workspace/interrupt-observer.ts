/**
 * ESC-interrupt observer (issue #15) — framework-free.
 *
 * An ESC interrupt ends a turn without ANY hook: claude-code's abort path
 * returns before its stop hooks run, so the daemon's hook-driven `running`
 * badge sat lit until the ~10min lapse watchdog caught it. The one
 * event-grade signal an interrupt does produce is the engine's own OSC
 * title rewrite — the animated working frame (`⠂`/`⠐`, codex's braille)
 * flips back to the resting form the instant the turn stops
 * (`engineTitleTurnHint`).
 *
 * This observer watches exactly that: a tab whose HOOK state says
 * `running` while its live title says "rest" arms a confirm timer; if the
 * disagreement still holds when it fires, `report` tells the daemon the
 * turn was interrupted (`engine.reportEvent` kind `turn-interrupted`) and
 * every attached client's badge flips.
 *
 * The confirm delay is the Stop-race guard: on a NATURAL turn end the
 * title flips a beat before the Stop hook lands, so acting immediately
 * would race the real event and an interrupt report arriving after Stop
 * would eat the unseen-● lamp (reduce(turn_complete, turn-interrupted) →
 * idle). Any hook movement away from `running` during the window —
 * turn_complete, permission_needed, anything — disarms the pending
 * confirm; Stop always wins.
 */

import { engineTitleTurnHint } from "../../engine/registry"
import type { VendorId } from "../../types/vendor"

/**
 * How long the title must keep saying "rest" against a hook-claimed
 * `running` before an interrupt is reported. The window only needs to
 * outlive a natural turn end's title→Stop gap: the Stop hook is a spawned
 * `kobe hook` process plus one daemon RPC, well under a second on a sane
 * machine — 2.5s covers a loaded one with margin, while keeping the ESC
 * flip inside the "immediately" a user perceives.
 */
export const INTERRUPT_CONFIRM_MS = 2500

/** One tab's inputs per observation pass. */
export interface InterruptObservation {
  /** The tab's RAW live OSC title (undecorated stripping breaks the signal). */
  readonly rawTitle: string | undefined
  /** The tab's resolved live engine identity (turn-target probe). */
  readonly vendor: VendorId | undefined
  /** Whether the daemon's hook state currently claims `running` for this tab. */
  readonly hookRunning: boolean
}

export interface InterruptObserverOptions {
  /**
   * Fire-time re-check: return true when the hook state STILL claims
   * `running` for the tab. Read from live state, not the arm-time
   * snapshot — a Stop that landed during the window must win the race.
   */
  readonly confirm: (tabId: string) => boolean
  /** Report the confirmed interrupt (fire-and-forget daemon RPC). */
  readonly report: (tabId: string) => void
  readonly confirmMs?: number
}

/** True when the observation says "engine at rest under a running claim". */
function disagrees(obs: InterruptObservation): boolean {
  if (!obs.hookRunning || !obs.vendor || obs.rawTitle === undefined) return false
  return engineTitleTurnHint(obs.vendor, obs.rawTitle) === "rest"
}

export class InterruptObserver {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly opts: InterruptObserverOptions) {}

  /**
   * Feed one tab's current observation. Arms the confirm timer on a fresh
   * running-vs-resting disagreement, re-arms nothing while one is pending,
   * and disarms the moment the disagreement clears (hook left `running` —
   * Stop/permission/idle — or the title says working again).
   */
  observe(tabId: string, obs: InterruptObservation): void {
    if (disagrees(obs)) {
      if (this.pending.has(tabId)) return
      const timer = setTimeout(() => {
        this.pending.delete(tabId)
        if (this.opts.confirm(tabId)) this.opts.report(tabId)
      }, this.opts.confirmMs ?? INTERRUPT_CONFIRM_MS)
      timer.unref?.()
      this.pending.set(tabId, timer)
      return
    }
    this.disarm(tabId)
  }

  private disarm(tabId: string): void {
    const timer = this.pending.get(tabId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.pending.delete(tabId)
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }
}
