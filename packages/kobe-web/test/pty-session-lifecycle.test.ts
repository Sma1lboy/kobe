import { EventEmitter } from "node:events"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createScrollback } from "../pty-scrollback.mjs"
import { createPtySessionManager } from "../pty-session-lifecycle.mjs"

class FakePty {
  data: ((data: string) => void) | null = null
  exit: (() => void) | null = null
  writes: string[] = []
  resizes: Array<{ cols: number; rows: number }> = []
  killed = false

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
})
