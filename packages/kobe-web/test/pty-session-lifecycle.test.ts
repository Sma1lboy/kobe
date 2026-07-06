import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createScrollback } from "../pty-scrollback.mjs"
import {
  createPtySessionManager,
  pickEvictableTab,
  shouldPausePty,
  shouldResumePty,
} from "../pty-session-lifecycle.mjs"

class FakePty {
  data: ((data: string) => void) | null = null
  exit: (() => void) | null = null
  writes: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []
  killed = false
  paused = false
  pauseCount = 0
  resumeCount = 0

  onData(cb: (data: string) => void): void {
    this.data = cb
  }

  onExit(cb: () => void): void {
    this.exit = cb
  }

  write(data: string): void {
    this.writes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows })
  }

  pause(): void {
    this.paused = true
    this.pauseCount += 1
  }

  resume(): void {
    this.paused = false
    this.resumeCount += 1
  }

  kill(): void {
    this.killed = true
  }

  emitData(data: string): void {
    this.data?.(data)
  }

  emitExit(): void {
    this.exit?.()
  }
}

class FakeSocket extends EventEmitter {
  OPEN = 1
  readyState = this.OPEN
  bufferedAmount = 0
  sent: string[] = []
  closes: Array<{ code?: number; reason?: string }> = []

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = 3
    this.emit("close")
  }

  message(data: string): void {
    this.emit("message", Buffer.from(data))
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function setup(over: Partial<Parameters<typeof createPtySessionManager>[0]> = {}) {
  const ptys: FakePty[] = []
  const fetchCalls: Array<{ taskId: string; mode: string }> = []
  const manager = createPtySessionManager({
    fetchSpec: async (taskId, mode) => {
      fetchCalls.push({ taskId, mode })
      return { cwd: `/repo/${taskId}`, command: ["engine", "--mode", mode] }
    },
    spawnPty: () => {
      const pty = new FakePty()
      ptys.push(pty)
      return pty
    },
    createScrollback,
    scrollbackCap: 1024,
    env: {},
    ...over,
  })
  return { manager, ptys, fetchCalls }
}

describe("createPtySessionManager", () => {
  beforeEach(() => {
    vi.useRealTimers()
  })

  it("coalesces concurrent attaches for one tab into one spawned PTY", async () => {
    const spec = deferred<{ cwd: string; command: string[] }>()
    const ptys: FakePty[] = []
    const manager = createPtySessionManager({
      fetchSpec: async () => spec.promise,
      spawnPty: () => {
        const pty = new FakePty()
        ptys.push(pty)
        return pty
      },
      createScrollback,
      scrollbackCap: 1024,
      env: {},
    })
    const a = new FakeSocket()
    const b = new FakeSocket()

    const p1 = manager.attachSocket({
      ws: a,
      tabId: "tab",
      taskId: "task",
      mode: "engine",
      cols: 80,
      rows: 24,
    })
    const p2 = manager.attachSocket({
      ws: b,
      tabId: "tab",
      taskId: "task",
      mode: "engine",
      cols: 100,
      rows: 30,
    })
    expect(manager.pendingSpawnCount()).toBe(1)

    spec.resolve({ cwd: "/repo", command: ["engine"] })
    await Promise.all([p1, p2])

    expect(ptys).toHaveLength(1)
    expect(manager.sessionCount()).toBe(1)
    expect(ptys[0].resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 100, rows: 30 },
    ])
  })

  it("replays scrollback before joining live fanout", async () => {
    const { manager, ptys } = setup()
    const first = new FakeSocket()
    await manager.attachSocket({
      ws: first,
      tabId: "tab",
      taskId: "task",
      mode: "engine",
      cols: 80,
      rows: 24,
    })
    ptys[0].emitData("old")
    first.emit("close")

    const second = new FakeSocket()
    await manager.attachSocket({
      ws: second,
      tabId: "tab",
      taskId: "task",
      mode: "engine",
      cols: 80,
      rows: 24,
    })
    ptys[0].emitData("new")

    expect(second.sent).toEqual(["old", "new"])
  })

  it("routes resize messages and raw input to the PTY", async () => {
    const { manager, ptys } = setup()
    const ws = new FakeSocket()
    await manager.attachSocket({
      ws,
      tabId: "tab",
      taskId: "task",
      mode: "shell",
      cols: 80,
      rows: 24,
    })

    ws.message(JSON.stringify({ type: "resize", cols: 0, rows: 48 }))
    ws.message("abc")

    expect(ptys[0].resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 1, rows: 48 },
    ])
    expect(ptys[0].writes).toEqual(["abc"])
  })

  it("spawn-on-send pastes with bracketed paste, then Enter", async () => {
    vi.useFakeTimers()
    const { manager, ptys } = setup({
      submitDelays: { spawnedPasteMs: 25, existingPasteMs: 0, enterMs: 10 },
    })

    await expect(
      manager.sendText({ tabId: "tab", taskId: "task", text: "hello" }),
    ).resolves.toEqual({ sent: true, spawned: true })
    expect(ptys).toHaveLength(1)
    expect(ptys[0].writes).toEqual([])

    await vi.advanceTimersByTimeAsync(25)
    expect(ptys[0].writes).toEqual(["\x1b[200~hello\x1b[201~"])
    await vi.advanceTimersByTimeAsync(10)
    expect(ptys[0].writes).toEqual(["\x1b[200~hello\x1b[201~", "\r"])
  })

  it("closes sockets and clears the session on process exit", async () => {
    const { manager, ptys } = setup()
    const ws = new FakeSocket()
    await manager.attachSocket({
      ws,
      tabId: "tab",
      taskId: "task",
      mode: "engine",
      cols: 80,
      rows: 24,
    })

    ptys[0].emitExit()

    expect(ws.closes).toEqual([{ code: 1000, reason: "engine exited" }])
    expect(manager.sessionCount()).toBe(0)
  })

  it("kills only the current session mapping on explicit close", async () => {
    const { manager, ptys } = setup()
    await manager.ensureSession("tab", "task", "engine", 80, 24)

    expect(manager.closeSession("tab")).toBe(true)
    expect(ptys[0].killed).toBe(true)
    expect(manager.sessionCount()).toBe(0)
    expect(manager.closeSession("tab")).toBe(false)
  })

  it("an old process exit cannot delete a new session for the same tab id", async () => {
    const { manager, ptys } = setup()
    await manager.ensureSession("tab", "task", "engine", 80, 24)
    const old = ptys[0]

    manager.closeSession("tab")
    await manager.ensureSession("tab", "task", "engine", 80, 24)
    expect(ptys).toHaveLength(2)
    old.emitExit()

    expect(manager.sessionCount()).toBe(1)
    expect(ptys[1].killed).toBe(false)
  })

  it("shutdown kills every tracked PTY and drops lifecycle state", async () => {
    const { manager, ptys } = setup()
    await manager.ensureSession("a", "task-a", "engine", 80, 24)
    await manager.ensureSession("b", "task-b", "shell", 80, 24)

    manager.shutdown()

    expect(ptys.map((pty) => pty.killed)).toEqual([true, true])
    expect(manager.sessionCount()).toBe(0)
    expect(manager.pendingSpawnCount()).toBe(0)
  })

  it("evicts the oldest unwatched session when the cap is hit", async () => {
    const { manager, ptys } = setup({ maxSessions: 2 })
    await manager.ensureSession("a", "task-a", "engine", 80, 24)
    await manager.ensureSession("b", "task-b", "engine", 80, 24)

    // Third tab over the cap of 2: oldest (a, no sockets) is killed + evicted.
    await manager.ensureSession("c", "task-c", "engine", 80, 24)

    expect(manager.sessionCount()).toBe(2)
    expect(ptys[0].killed).toBe(true)
    expect(manager.closeSession("a")).toBe(false)
    expect(manager.closeSession("c")).toBe(true)
  })

  it("rejects a new session when every session is actively viewed", async () => {
    const { manager } = setup({ maxSessions: 2 })
    const a = new FakeSocket()
    const b = new FakeSocket()
    await manager.attachSocket({ ws: a, tabId: "a", taskId: "task-a", mode: "engine", cols: 80, rows: 24 })
    await manager.attachSocket({ ws: b, tabId: "b", taskId: "task-b", mode: "engine", cols: 80, rows: 24 })

    const c = new FakeSocket()
    await expect(
      manager.attachSocket({ ws: c, tabId: "c", taskId: "task-c", mode: "engine", cols: 80, rows: 24 }),
    ).rejects.toThrow(/session limit reached/)
    expect(manager.sessionCount()).toBe(2)
  })

  it("re-attaching an existing tab at the cap does not evict", async () => {
    const { manager } = setup({ maxSessions: 2 })
    await manager.ensureSession("a", "task-a", "engine", 80, 24)
    await manager.ensureSession("b", "task-b", "engine", 80, 24)

    // ensureSession("a") returns the existing entry — no spawn, no eviction.
    await manager.ensureSession("a", "task-a", "engine", 80, 24)
    expect(manager.sessionCount()).toBe(2)
    expect(manager.closeSession("b")).toBe(true)
  })

  it("pauses the pty when a socket saturates and resumes once it drains", async () => {
    vi.useFakeTimers()
    const { manager, ptys } = setup({
      backpressure: { highWaterBytes: 100, lowWaterBytes: 50, drainPollMs: 10 },
    })
    const ws = new FakeSocket()
    await manager.attachSocket({ ws, tabId: "tab", taskId: "task", mode: "engine", cols: 80, rows: 24 })

    ws.bufferedAmount = 200
    ptys[0].emitData("flood")
    expect(ptys[0].paused).toBe(true)
    expect(ptys[0].pauseCount).toBe(1)

    // A second flood while already paused must not re-pause.
    ptys[0].emitData("more")
    expect(ptys[0].pauseCount).toBe(1)

    // Still saturated → no resume on the drain poll.
    vi.advanceTimersByTime(10)
    expect(ptys[0].paused).toBe(true)

    // Drained back under the low-water mark → resume on the next poll.
    ws.bufferedAmount = 0
    vi.advanceTimersByTime(10)
    expect(ptys[0].paused).toBe(false)
    expect(ptys[0].resumeCount).toBe(1)
  })

  it("does not pause while sockets stay under the high-water mark", async () => {
    vi.useFakeTimers()
    const { manager, ptys } = setup({
      backpressure: { highWaterBytes: 100, lowWaterBytes: 50, drainPollMs: 10 },
    })
    const ws = new FakeSocket()
    await manager.attachSocket({ ws, tabId: "tab", taskId: "task", mode: "engine", cols: 80, rows: 24 })

    ws.bufferedAmount = 80
    ptys[0].emitData("ok")
    expect(ptys[0].paused).toBe(false)
    expect(ptys[0].pauseCount).toBe(0)
  })
})

describe("pickEvictableTab", () => {
  it("returns the first session (insertion order) with no sockets", () => {
    const sessions = new Map<string, { sockets: Set<unknown> }>([
      ["a", { sockets: new Set(["s"]) }],
      ["b", { sockets: new Set() }],
      ["c", { sockets: new Set() }],
    ])
    expect(pickEvictableTab(sessions)).toBe("b")
  })

  it("returns null when every session is actively viewed", () => {
    const sessions = new Map<string, { sockets: Set<unknown> }>([
      ["a", { sockets: new Set(["s"]) }],
    ])
    expect(pickEvictableTab(sessions)).toBeNull()
    expect(pickEvictableTab(new Map())).toBeNull()
  })
})

describe("shouldPausePty / shouldResumePty", () => {
  const sock = (bufferedAmount: number, open = true) => ({
    OPEN: 1,
    readyState: open ? 1 : 3,
    bufferedAmount,
  })

  it("pauses when ANY open socket is over the high-water mark", () => {
    expect(shouldPausePty([sock(50), sock(200)], 100)).toBe(true)
    expect(shouldPausePty([sock(50), sock(90)], 100)).toBe(false)
    expect(shouldPausePty([], 100)).toBe(false)
  })

  it("ignores closed sockets when deciding to pause", () => {
    expect(shouldPausePty([sock(999, false)], 100)).toBe(false)
  })

  it("resumes only when EVERY open socket is under the low-water mark", () => {
    expect(shouldResumePty([sock(10), sock(40)], 50)).toBe(true)
    expect(shouldResumePty([sock(10), sock(60)], 50)).toBe(false)
    expect(shouldResumePty([], 50)).toBe(true)
  })

  it("ignores closed sockets when deciding to resume", () => {
    expect(shouldResumePty([sock(999, false)], 50)).toBe(true)
  })
})
