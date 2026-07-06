import { DaemonLifetime, type LifetimeClient, type ScheduleFn } from "@sma1lboy/kobe-daemon/daemon/lifetime"
import { describe, expect, it, vi } from "vitest"

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
    clients.length = 0
    lifetime.clientDisconnected(true)
    expect(onIdleStop).not.toHaveBeenCalled()
    clock.fire()
    expect(onIdleStop).toHaveBeenCalledTimes(1)
  })

  it("does not arm while another gui remains", () => {
    const { lifetime, onIdleStop, clock, clients } = make([GUI, GUI])
    clients.pop()
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
    lifetime.clientDisconnected(true)
    clients.push(GUI)
    lifetime.guiAttached()
    clock.fire()
    expect(onIdleStop).not.toHaveBeenCalled()
  })

  it("a pane subscribing during the grace does NOT cancel shutdown", () => {
    const { lifetime, onIdleStop, clock, clients } = make([GUI])
    clients.length = 0
    lifetime.clientDisconnected(true)
    clients.push(PANE)
    clock.fire()
    expect(onIdleStop).toHaveBeenCalledTimes(1)
  })

  it("markStopping cancels a pending grace and suppresses re-arm", () => {
    const { lifetime, onIdleStop, clock, clients } = make([GUI])
    clients.length = 0
    lifetime.clientDisconnected(true)
    lifetime.markStopping()
    expect(lifetime.isStopping()).toBe(true)
    clock.fire()
    expect(onIdleStop).not.toHaveBeenCalled()
    lifetime.clientDisconnected(true)
    clock.fire()
    expect(onIdleStop).not.toHaveBeenCalled()
  })
})
