import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RECONNECT_LOG_ATTEMPT_CEILING,
  shouldLogReconnectAttempt,
} from "../../src/client/remote-orchestrator-payloads.ts"
import { RemoteOrchestrator } from "../../src/client/remote-orchestrator.ts"

/**
 * Issue #26: with many long-lived orphan panes each retrying forever, even
 * "log attempt 1 and every 10th" is unbounded spam over days (client.log
 * hit 736MB). `shouldLogReconnectAttempt` adds a hard ceiling — silent
 * after `RECONNECT_LOG_ATTEMPT_CEILING`, until a successful reconnect
 * resets the caller's attempt counter back to 0.
 */
describe("shouldLogReconnectAttempt", () => {
  it("logs attempt 1", () => {
    expect(shouldLogReconnectAttempt(1)).toBe(true)
  })

  it("logs every 10th attempt", () => {
    expect(shouldLogReconnectAttempt(10)).toBe(true)
    expect(shouldLogReconnectAttempt(20)).toBe(true)
    expect(shouldLogReconnectAttempt(100)).toBe(true)
  })

  it("stays silent on non-1st, non-10th attempts", () => {
    expect(shouldLogReconnectAttempt(2)).toBe(false)
    expect(shouldLogReconnectAttempt(11)).toBe(false)
    expect(shouldLogReconnectAttempt(99)).toBe(false)
  })

  it("goes silent for every attempt past the ceiling, even a would-be 10th", () => {
    expect(shouldLogReconnectAttempt(RECONNECT_LOG_ATTEMPT_CEILING)).toBe(true) // last one logged
    expect(shouldLogReconnectAttempt(RECONNECT_LOG_ATTEMPT_CEILING + 1)).toBe(false)
    expect(shouldLogReconnectAttempt(RECONNECT_LOG_ATTEMPT_CEILING + 10)).toBe(false) // would be a 10th, still silent
    expect(shouldLogReconnectAttempt(100_000)).toBe(false)
  })
})

/**
 * Auto-reconnect is the permanent fix for the Tasks-pane create/delete sync
 * drift: a pane that subscribed at boot used to FREEZE its task list when the
 * daemon later idle-stopped / restarted (socket close, no reconnect, no
 * fallback). The contract these lock:
 *   - role "pane"  → on socket close, RETRY a plain reconnect (re-`init`) so
 *     the bus replays the current snapshot and the pane re-syncs.
 *   - role "gui"   → do NOT auto-reconnect (the front-end shows a modal).
 *   - the pane reconnect must be NON-SPAWNING (never `ensureReachable`), or
 *     it would resurrect an idle-stopped daemon and break lazy-shutdown.
 */

interface Harness {
  client: KobeDaemonClient
  triggerClose: () => void
  helloCount: () => number
  setDisposed: (v: boolean) => void
}

function fakeClient(): Harness {
  let closeHandler: (() => void) | undefined
  let disposed = false
  let hellos = 0
  const client = {
    on: () => () => {},
    onLifecycle: (name: string, handler: () => void) => {
      if (name === "close") closeHandler = handler
      return () => {}
    },
    get isDisposed() {
      return disposed
    },
    request: (name: string) => {
      if (name === "hello") {
        hellos++
        return Promise.resolve({ protocolVersion: 2, minProtocolVersion: 2, tasks: [] })
      }
      return Promise.resolve({})
    },
    subscribe: () => Promise.resolve({}),
  } as unknown as KobeDaemonClient
  return {
    client,
    triggerClose: () => closeHandler?.(),
    helloCount: () => hellos,
    setDisposed: (v) => {
      disposed = v
    },
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("RemoteOrchestrator auto-reconnect", () => {
  let home: string
  const prev = process.env.KOBE_HOME_DIR

  beforeEach(async () => {
    // init() logs to client.log — keep that off the real ~/.kobe.
    home = await mkdtemp(join(tmpdir(), "kobe-orch-reconnect-"))
    process.env.KOBE_HOME_DIR = home
  })

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env must fully unset when it was unset pre-test (assigning undefined leaves the string "undefined").
    if (prev === undefined) delete process.env.KOBE_HOME_DIR
    else process.env.KOBE_HOME_DIR = prev
    await rm(home, { recursive: true, force: true })
  })

  it("a pane re-inits after the socket closes, without spawning a daemon", async () => {
    const h = fakeClient()
    let ensureCalls = 0
    const orch = new RemoteOrchestrator(h.client, {
      role: "pane",
      ensureReachable: async () => {
        ensureCalls++
      },
    })
    expect(orch.connectionStateSignal()()).toBe("online")

    h.triggerClose()
    expect(orch.connectionStateSignal()()).toBe("disconnected")

    // The loop's first attempt fires after a 500ms backoff.
    await sleep(800)
    expect(h.helloCount()).toBeGreaterThanOrEqual(1) // re-subscribed
    expect(ensureCalls).toBe(0) // NON-spawning — never resurrects the daemon
    expect(orch.connectionStateSignal()()).toBe("online") // re-synced
  })

  it("a gui does NOT auto-reconnect (waits for the user's modal)", async () => {
    const h = fakeClient()
    const orch = new RemoteOrchestrator(h.client, { role: "gui" })
    h.triggerClose()
    expect(orch.connectionStateSignal()()).toBe("disconnected")
    await sleep(800)
    expect(h.helloCount()).toBe(0) // no reconnect attempted
    expect(orch.connectionStateSignal()()).toBe("disconnected")
  })

  it("stops retrying once the client is disposed", async () => {
    const h = fakeClient()
    h.setDisposed(true) // host tore the pane down
    const orch = new RemoteOrchestrator(h.client, { role: "pane" })
    h.triggerClose()
    await sleep(800)
    expect(h.helloCount()).toBe(0) // disposed → loop bails before any attempt
  })
})
