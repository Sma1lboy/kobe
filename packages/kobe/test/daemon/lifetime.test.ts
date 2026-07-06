import { DaemonLifetime, type LifetimeClient, type ScheduleFn } from "@sma1lboy/kobe-daemon/daemon/lifetime"
import { describe, expect, it, vi } from "vitest"

/**
 * Unit coverage for the daemon's lazy-shutdown + collector-gate policy in
 * isolation — no socket, no wall-clock grace. The end-to-end socket behavior is
 * covered by lazy-shutdown.test.ts; this pins the policy rules so a refactor of
 * server.ts can't silently change when the daemon self-stops.
 */

/** A manual clock: captures scheduled callbacks so a test fires them on demand,
 *  and honors cancellation exactly as the real unref'd setTimeout would. */
function manualClock(): { schedule: ScheduleFn; fire: () => void } {
  const pending: Array<{ fn: () => void; cancelled: boolean }> = []
  const schedule: ScheduleFn = (fn) => {
    const entry = { fn, cancelled: false }
    pending.push(entry)
    return () => {
      entry.cancelled = true
    }
  }
  return {
    schedule,
    fire: () => {
      for (const e of pending) if (!e.cancelled) e.fn()
    },
  }
}

const GUI: LifetimeClient = { subscribed: true, holdsLifetime: true }
const PANE: LifetimeClient = { subscribed: true, holdsLifetime: false }

function make(clients: LifetimeClient[]) {
  const clock = manualClock()
  const onIdleStop = vi.fn()
  const lifetime = new DaemonLifetime({
    clients: () => clients,
    idleGraceMs: 50,
    onIdleStop,
    schedule: clock.schedule,
    log: () => {},
  })
  return { lifetime, onIdleStop, clock, clients }
}

describe("DaemonLifetime", () => {
  it("counts only gui clients for the lifetime refcount, any subscriber for the collector gate", () => {
    const { lifetime } = make([GUI, PANE, PANE])
    expect(lifetime.guiCount()).toBe(1)
    expect(lifetime.hasSubscribers()).toBe(true)
  })

  it("self-stops a grace after the last gui disconnects", () => {
    const { lifetime, onIdleStop, clock, clients } = make([GUI])
    clients.length = 0 // the gui's socket closed
    lifetime.clientDisconnected(true)
    expect(onIdleStop).not.toHaveBeenCalled()
    clock.fire()
    expect(onIdleStop).toHaveBeenCalledTimes(1)
  })

  it("does not arm while another gui remains", () => {
    const { lifetime, onIdleStop, clock, clients } = make([GUI, GUI])
    clients.pop() // one gui closed, one remains
    lifetime.clientDisconnected(true)
    clock.fire()
    expect(onIdleStop).not.toHaveBeenCalled()
  })

  it("a pane disconnect never arms shutdown", () => {
    const { lifetime, onIdleStop, clock, clients } = make([PANE])
    clients.length = 0
    lifetime.clientDisconnected(false)
    clock.fire()
    expect(onIdleStop).not.toHaveBeenCalled()
  })

  it("a gui re-attach cancels a pending grace", () => {
    const { lifetime, onIdleStop, clock, clients } = make([GUI])
    clients.length = 0
    lifetime.clientDisconnected(true) // arms
    clients.push(GUI) // a gui re-attached
    lifetime.guiAttached() // must cancel
    clock.fire()
    expect(onIdleStop).not.toHaveBeenCalled()
  })

  it("a pane subscribing during the grace does NOT cancel shutdown", () => {
    const { lifetime, onIdleStop, clock, clients } = make([GUI])
    clients.length = 0
    lifetime.clientDisconnected(true) // arms
    clients.push(PANE) // a pane connected mid-grace — guiAttached NOT called
    clock.fire()
    expect(onIdleStop).toHaveBeenCalledTimes(1)
  })

  it("markStopping cancels a pending grace and suppresses re-arm", () => {
    const { lifetime, onIdleStop, clock, clients } = make([GUI])
    clients.length = 0
    lifetime.clientDisconnected(true) // arms
    lifetime.markStopping()
    expect(lifetime.isStopping()).toBe(true)
    clock.fire()
    expect(onIdleStop).not.toHaveBeenCalled()
    // A later disconnect can't re-arm once stopping.
    lifetime.clientDisconnected(true)
    clock.fire()
    expect(onIdleStop).not.toHaveBeenCalled()
  })
})
