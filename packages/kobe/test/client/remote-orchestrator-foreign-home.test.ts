import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RemoteOrchestrator } from "../../src/client/remote-orchestrator.ts"

/**
 * Home-ownership guard (prod 2026-08-13).
 *
 * A `dev:sandbox` daemon inherited `KOBE_DAEMON_SOCKET_PATH` from the task
 * terminal it was launched in. Because an explicit socket override outranks
 * `*_HOME_DIR`, it bound the PRODUCTION socket while serving its own — empty —
 * task index. Attached TUIs reconnected onto it, `hello` succeeded, and the
 * sidebar went blank ("No active tasks") with all 27 tasks intact on disk.
 *
 * Every other handshake check passed, because nothing was wrong with the
 * wire. What these lock is that a client refuses a daemon belonging to a
 * DIFFERENT home before adopting a single task from it.
 */

const FOREIGN_TASK = {
  id: "01KZZZZZZZZZZZZZZZZZZZZZZZ",
  title: "a sandbox task that is not ours",
  repo: "/sandbox/repo",
  branch: "sandbox/branch",
  worktreePath: "/sandbox/wt",
  kind: "main",
  status: "backlog",
  archived: false,
  pinned: false,
  vendor: "claude",
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
}

function fakeClient(hello: Record<string, unknown>): KobeDaemonClient {
  return {
    on: () => () => {},
    onLifecycle: () => () => {},
    get isDisposed() {
      return false
    },
    request: (name: string) =>
      name === "hello" ? Promise.resolve({ protocolVersion: 2, minProtocolVersion: 2, ...hello }) : Promise.resolve({}),
    subscribe: () => Promise.resolve({}),
  } as unknown as KobeDaemonClient
}

describe("RemoteOrchestrator home-ownership guard", () => {
  let home: string
  const prev = process.env.KOBE_HOME_DIR

  beforeEach(async () => {
    // init() logs to client.log — keep that off the real ~/.kobe.
    home = await mkdtemp(join(tmpdir(), "kobe-orch-home-"))
    process.env.KOBE_HOME_DIR = home
  })

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: env must fully unset when it was unset pre-test (assigning undefined leaves the string "undefined").
    if (prev === undefined) delete process.env.KOBE_HOME_DIR
    else process.env.KOBE_HOME_DIR = prev
    await rm(home, { recursive: true, force: true })
  })

  it("refuses a daemon serving a different home, and adopts none of its tasks", async () => {
    const orch = new RemoteOrchestrator(fakeClient({ homeDir: "/repo/packages/kobe/.dev-sandbox/home", tasks: [] }), {
      role: "gui",
    })

    await expect(orch.init()).rejects.toThrow(/serves \/repo\/packages\/kobe\/\.dev-sandbox\/home/)
    expect(orch.tasksSignal()()).toEqual([])
  })

  it("never lets a foreign daemon's task list reach the sidebar", async () => {
    // The blast radius that mattered: an EMPTY list read as truth. Assert the
    // inverse too — a foreign daemon's tasks are equally untrusted.
    const orch = new RemoteOrchestrator(fakeClient({ homeDir: "/elsewhere", tasks: [FOREIGN_TASK] }), { role: "gui" })

    await expect(orch.init()).rejects.toThrow(/A sandbox or dev daemon has taken the production socket/)
    expect(orch.tasksSignal()()).toEqual([])
  })

  it("accepts a daemon on the same home and hydrates its tasks", async () => {
    const orch = new RemoteOrchestrator(fakeClient({ homeDir: home, tasks: [FOREIGN_TASK] }), { role: "gui" })

    await orch.init()
    expect(orch.tasksSignal()()).toHaveLength(1)
    expect(orch.connectionStateSignal()()).toBe("online")
  })

  it("accepts a daemon that predates the homeDir field (rolling upgrade)", async () => {
    // Same tolerance as the kobeVersion handshake: an old daemon omits the
    // field and must not be rejected on evidence it cannot supply.
    const orch = new RemoteOrchestrator(fakeClient({ tasks: [FOREIGN_TASK] }), { role: "gui" })

    await orch.init()
    expect(orch.tasksSignal()()).toHaveLength(1)
  })
})
