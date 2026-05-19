import { describe, expect, it } from "vitest"
import { type PaneClient, PaneError, parsePaneArgs, renderPaneLine, runPane } from "../../src/cli/pane.ts"
import type { DaemonEventHandler } from "../../src/client/index.ts"
import type { DaemonEventName, DaemonRequestName, SerializedTask } from "../../src/daemon/protocol.ts"

describe("parsePaneArgs", () => {
  it("parses a name-only invocation", () => {
    const parsed = parsePaneArgs(["sidebar"])
    expect(parsed.name).toBe("sidebar")
    expect(parsed.once).toBe(false)
  })

  it("recognises --once", () => {
    expect(parsePaneArgs(["sidebar", "--once"]).once).toBe(true)
    expect(parsePaneArgs(["--once", "files"]).once).toBe(true)
  })

  it("throws on missing pane name", () => {
    expect(() => parsePaneArgs([])).toThrow(PaneError)
    expect(() => parsePaneArgs(["--once"])).toThrow(/missing pane name/)
  })

  it("throws on unknown pane name", () => {
    expect(() => parsePaneArgs(["sidebarrr"])).toThrow(/unknown pane/)
  })

  it("throws on unknown flag", () => {
    expect(() => parsePaneArgs(["sidebar", "--what"])).toThrow(/unknown flag/)
  })
})

function fakeTask(overrides: Partial<SerializedTask> = {}): SerializedTask {
  return {
    id: "t1",
    title: "demo task",
    repo: "/tmp/repo",
    branch: "main",
    worktreePath: "/tmp/worktree-t1",
    kind: "task",
    sessionId: null,
    tabs: [
      { id: "tab-1", sessionId: null, seq: 1, createdAt: "2026-05-19T00:00:00.000Z" },
      { id: "tab-2", sessionId: null, seq: 2, title: "Merge", createdAt: "2026-05-19T00:01:00.000Z" },
    ],
    activeTabId: "tab-1",
    status: "in_progress",
    archived: false,
    pinned: false,
    createdAt: "2026-05-19T00:00:00.000Z",
    updatedAt: "2026-05-19T00:00:00.000Z",
    ...overrides,
  }
}

describe("renderPaneLine", () => {
  it("sidebar — active set", () => {
    expect(renderPaneLine("sidebar", { tasks: [fakeTask()], activeTaskId: "t1" })).toBe(
      "[sidebar] tasks: 1 (active=t1)",
    )
  })

  it("sidebar — no active", () => {
    expect(renderPaneLine("sidebar", { tasks: [], activeTaskId: null })).toBe("[sidebar] tasks: 0 (active=none)")
  })

  it("tab-strip — active task with two tabs, default chat-N titles + custom title", () => {
    const line = renderPaneLine("tab-strip", { tasks: [fakeTask()], activeTaskId: "t1" })
    expect(line).toBe("[tab-strip] task=demo task tabs: [ chat 1* Merge ]")
  })

  it("tab-strip — no active task", () => {
    expect(renderPaneLine("tab-strip", { tasks: [], activeTaskId: null })).toBe("[tab-strip] task=none tabs: [ ]")
  })

  it("files — active set", () => {
    expect(renderPaneLine("files", { tasks: [fakeTask()], activeTaskId: "t1" })).toBe(
      "[files] worktree=/tmp/worktree-t1",
    )
  })

  it("files — no active", () => {
    expect(renderPaneLine("files", { tasks: [], activeTaskId: null })).toBe("[files] worktree=none")
  })

  it("status — active set", () => {
    expect(renderPaneLine("status", { tasks: [fakeTask()], activeTaskId: "t1" })).toBe("[status] tasks=1 active=t1")
  })

  it("status — no active", () => {
    expect(renderPaneLine("status", { tasks: [], activeTaskId: null })).toBe("[status] tasks=0 active=none")
  })
})

interface FakeOptions {
  connectThrows?: Error
  helloPayload?: { tasks: SerializedTask[]; activeTaskId: string | null }
}

function createFakeClient(opts: FakeOptions = {}): {
  client: PaneClient
  closed: { value: boolean }
} {
  const closed = { value: false }
  const handlers = new Map<DaemonEventName | "*", Set<DaemonEventHandler>>()
  const client: PaneClient = {
    async connect() {
      if (opts.connectThrows) throw opts.connectThrows
    },
    async request<T>(name: DaemonRequestName): Promise<T> {
      if (name === "hello")
        return (opts.helloPayload ?? { tasks: [], activeTaskId: null }) as unknown as T
      return {} as T
    },
    on(name, handler) {
      let set = handlers.get(name)
      if (!set) {
        set = new Set()
        handlers.set(name, set)
      }
      set.add(handler)
      return () => set?.delete(handler)
    },
    close() {
      closed.value = true
    },
  }
  return { client, closed }
}

describe("runPane (smoke)", () => {
  function captureIo() {
    const out: string[] = []
    const err: string[] = []
    return {
      out,
      err,
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
    }
  }

  it("--once renders one frame after hello and exits cleanly", async () => {
    const { client, closed } = createFakeClient({
      helloPayload: { tasks: [fakeTask()], activeTaskId: "t1" },
    })
    const io = captureIo()
    const renders: string[] = []
    const result = await runPane(["sidebar", "--once"], {
      clientFactory: () => client,
      socketPath: "/tmp/unused.sock",
      stdout: io.stdout,
      stderr: io.stderr,
      onRender: (line) => renders.push(line),
    })
    expect(result.exitCode).toBe(0)
    expect(closed.value).toBe(true)
    expect(renders).toEqual(["[sidebar] tasks: 1 (active=t1)"])
    expect(io.out.join("")).toContain("[sidebar] tasks: 1 (active=t1)")
  })

  it("reports BAD_DAEMON when connect fails", async () => {
    const { client } = createFakeClient({ connectThrows: new Error("ENOENT") })
    const io = captureIo()
    const result = await runPane(["sidebar", "--once"], {
      clientFactory: () => client,
      socketPath: "/nope/daemon.sock",
      stdout: io.stdout,
      stderr: io.stderr,
    })
    expect(result.exitCode).toBe(2)
    const errBody = JSON.parse(io.err.join(""))
    expect(errBody.error.code).toBe("BAD_DAEMON")
  })

  it("rejects unknown pane name before connecting", async () => {
    const { client } = createFakeClient()
    const io = captureIo()
    const result = await runPane(["bogus"], {
      clientFactory: () => client,
      socketPath: "/tmp/unused.sock",
      stdout: io.stdout,
      stderr: io.stderr,
    })
    expect(result.exitCode).toBe(2)
    const errBody = JSON.parse(io.err.join(""))
    expect(errBody.error.code).toBe("BAD_NAME")
  })
})
