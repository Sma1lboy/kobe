import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { connectPaneOrchestrator } from "../../src/client/connect-pane-orchestrator.ts"
import { RemoteOrchestrator } from "../../src/client/remote-orchestrator.ts"

interface FakeClient {
  client: KobeDaemonClient
  closed: () => boolean
  lastSubscribe: () => { role?: string; channels?: readonly string[] } | null
}

function fakeClient(helloOutcome: "ok" | "skew"): FakeClient {
  let closedFlag = false
  let subscribeArgs: { role?: string; channels?: readonly string[] } | null = null
  const client = {
    on: () => () => {},
    onLifecycle: () => () => {},
    get isDisposed() {
      return closedFlag
    },
    request: (name: string) => {
      if (name === "hello") {
        if (helloOutcome === "skew") {
          return Promise.resolve({ protocolVersion: 999, minProtocolVersion: 999, tasks: [] })
        }
        return Promise.resolve({ protocolVersion: 2, minProtocolVersion: 2, tasks: [] })
      }
      return Promise.resolve({})
    },
    subscribe: (opts: { role?: string; channels?: readonly string[] } = {}) => {
      subscribeArgs = opts
      return Promise.resolve({})
    },
    close: () => {
      closedFlag = true
    },
  } as unknown as KobeDaemonClient
  return { client, closed: () => closedFlag, lastSubscribe: () => subscribeArgs }
}

describe("connectPaneOrchestrator", () => {
  let home: string
  const prev = process.env.KOBE_HOME_DIR

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kobe-connect-pane-"))
    process.env.KOBE_HOME_DIR = home
  })

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env must fully unset when it was unset pre-test.
    if (prev === undefined) delete process.env.KOBE_HOME_DIR
    else process.env.KOBE_HOME_DIR = prev
    await rm(home, { recursive: true, force: true })
  })

  it("returns null and never throws when no daemon is running", async () => {
    const orch = await connectPaneOrchestrator({ connect: async () => null, logTag: "test" })
    expect(orch).toBeNull()
  })

  it("disposes the half-built orchestrator when the handshake fails", async () => {
    const fake = fakeClient("skew")
    const orch = await connectPaneOrchestrator({ connect: async () => fake.client, logTag: "test" })
    expect(orch).toBeNull()
    expect(fake.closed()).toBe(true)
  })

  it("returns a live orchestrator and forwards the channel filter on success", async () => {
    const fake = fakeClient("ok")
    const orch = await connectPaneOrchestrator({
      connect: async () => fake.client,
      channels: ["ui-prefs", "keybindings"],
      logTag: "test",
    })
    expect(orch).not.toBeNull()
    expect(fake.closed()).toBe(false)
    expect(fake.lastSubscribe()).toEqual({ role: "pane", channels: ["ui-prefs", "keybindings"] })
    orch?.dispose()
  })
})

function helloTaskClient(): KobeDaemonClient {
  return {
    on: () => () => {},
    onLifecycle: () => () => {},
    get isDisposed() {
      return false
    },
    request: (name: string) => {
      if (name === "hello") {
        return Promise.resolve({
          protocolVersion: 2,
          minProtocolVersion: 2,
          tasks: [
            {
              id: "t1",
              title: "t1",
              repo: "/repo",
              branch: "t1",
              worktreePath: "/wt/t1",
              kind: "worktree",
              status: "backlog",
              archived: false,
              pinned: false,
              vendor: "claude",
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        })
      }
      return Promise.resolve({})
    },
    subscribe: () => Promise.resolve({}),
    close: () => {},
  } as unknown as KobeDaemonClient
}

describe("RemoteOrchestrator channel filter", () => {
  let home: string
  const prev = process.env.KOBE_HOME_DIR

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kobe-orch-filter-"))
    process.env.KOBE_HOME_DIR = home
  })

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env must fully unset when it was unset pre-test.
    if (prev === undefined) delete process.env.KOBE_HOME_DIR
    else process.env.KOBE_HOME_DIR = prev
    await rm(home, { recursive: true, force: true })
  })

  it("hydrates the hello task list when subscribed to task.snapshot (default)", async () => {
    const orch = new RemoteOrchestrator(helloTaskClient())
    await orch.init()
    expect(orch.listTasks().map((t) => t.id)).toEqual(["t1"])
  })

  it("skips hello task hydration when the filter excludes task.snapshot", async () => {
    const orch = new RemoteOrchestrator(helloTaskClient(), { channels: ["ui-prefs", "keybindings"] })
    await orch.init()
    expect(orch.listTasks()).toEqual([])
  })
})
