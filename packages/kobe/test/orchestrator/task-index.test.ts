/**
 * Unit tests for the task-index store, ulid, and lockfile.
 *
 * Why these tests matter:
 *   - The task index is the orchestrator's only persistent state.
 *     A bug here = lost or duplicated tasks. Higher cost than a UI bug.
 *   - The atomic-write contract (write-tmp + rename) only matters if a
 *     crash during save can be recovered from. We simulate that crash.
 *   - The lockfile contract is the only thing keeping a future second
 *     kobe instance from racing into a corrupt manifest.
 *   - The ULID monotonicity property is what lets the sidebar sort by
 *     id alone — if it breaks, sidebar ordering breaks silently.
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

import { LockfileError, acquire, isProcessAlive, release } from "../../src/orchestrator/index/lockfile.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { ULID_ALPHABET, _resetUlidStateForTests, ulid } from "../../src/orchestrator/index/ulid.ts"

// All tests share this template for fixtures: a fresh tmp homeDir per test.
let homeDir: string

beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "kobe-test-"))
})

afterEach(async () => {
  // Best-effort cleanup. Don't blow up the suite if a test left a busy file.
  try {
    await rm(homeDir, { recursive: true, force: true })
  } catch {
    /* swallow */
  }
})

// ---------------------------------------------------------------------------
// CRUD round-trip
// ---------------------------------------------------------------------------

describe("TaskIndexStore — CRUD", () => {
  test("create → list → get → update → archive round-trips through disk", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    expect(store.list()).toEqual([])

    const t = await store.create({
      title: "first",
      repo: "/repo",
      branch: "kobe/first",
      worktreePath: "/repo/.claude/worktrees/first",
      sessionId: null,
      status: "backlog",
    })

    expect(t.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(t.createdAt).toBe(t.updatedAt)
    expect(store.list()).toHaveLength(1)
    expect(store.get(t.id)).toEqual(t)

    // The file lives where the contract says it does.
    const onDisk = JSON.parse(await readFile(store.filePath, "utf8"))
    expect(onDisk.version).toBe(2)
    expect(onDisk.tasks).toHaveLength(1)
    expect(onDisk.tasks[0]).toEqual(t)

    // update bumps updatedAt and persists; immutable fields stick.
    // Tiny sleep so updatedAt ticks past the millisecond of createdAt.
    await new Promise((r) => setTimeout(r, 5))
    // Attempts to touch immutable fields (id, createdAt) are silently
    // dropped at runtime. The type signature accepts them via
    // Partial<Task>; we exercise the runtime guard explicitly here.
    const sneaky = {
      status: "in_progress" as const,
      sessionId: "sess-1",
      id: "nope",
      createdAt: "1970-01-01T00:00:00Z",
    }
    const updated = await store.update(t.id, sneaky as unknown as Partial<typeof t>)
    expect(updated.id).toBe(t.id)
    expect(updated.createdAt).toBe(t.createdAt)
    expect(updated.status).toBe("in_progress")
    expect(updated.sessionId).toBe("sess-1")
    expect(updated.updatedAt > t.updatedAt).toBe(true)

    // archive() flips status terminal; default = "done".
    const archived = await store.archive(t.id)
    expect(archived.status).toBe("done")
    const canceled = await store.archive(t.id, "canceled")
    expect(canceled.status).toBe("canceled")

    // After archive, the task is still present in the list.
    expect(store.list()).toHaveLength(1)
    expect(store.get(t.id)?.status).toBe("canceled")

    // Re-loading from disk preserves state.
    const reopened = new TaskIndexStore({ homeDir })
    const idx = await reopened.load()
    expect(idx.tasks).toHaveLength(1)
    expect(idx.tasks[0]?.status).toBe("canceled")
  })

  test("update() throws on unknown id", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    await expect(store.update("missing", { status: "done" })).rejects.toThrow(/not found/)
  })

  test("methods refuse to run before load()", async () => {
    const store = new TaskIndexStore({ homeDir })
    expect(() => store.list()).toThrow(/load\(\)/)
  })

  test("missing file loads as empty index without throwing", async () => {
    const store = new TaskIndexStore({ homeDir })
    const idx = await store.load()
    expect(idx).toEqual({ version: 2, tasks: [] })
  })
})

// ---------------------------------------------------------------------------
// Change notification (subscribe) — load-bearing for the orchestrator's
// Solid signal that backs the sidebar. Without this, mutations on the
// store don't reach the in-memory `Task[]` mirror used by the sidebar's
// `<For>` and the row stays stuck on its old status group + badge —
// which is the exact bug Jackson reported (task done in tasks.json,
// sidebar still showing it under Backlog with `○`).
// ---------------------------------------------------------------------------

describe("TaskIndexStore — subscribe", () => {
  test("listener fires once eagerly on subscribe with the current snapshot", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    await store.create({
      title: "preexisting",
      repo: "/r",
      branch: "kobe/preexisting",
      worktreePath: "/r/wt",
      sessionId: null,
      status: "done",
    })
    const seen: string[][] = []
    const unsub = store.subscribe((snap) => {
      seen.push(snap.map((t) => t.title))
    })
    expect(seen).toEqual([["preexisting"]])
    unsub()
  })

  test("listener fires on every create/update/archive mutation", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const calls: { count: number; statuses: string[] }[] = []
    store.subscribe((snap) => {
      calls.push({ count: snap.length, statuses: snap.map((t) => t.status) })
    })
    // Initial eager fire (empty list).
    expect(calls.at(-1)).toEqual({ count: 0, statuses: [] })

    const t = await store.create({
      title: "x",
      repo: "/r",
      branch: "kobe/x",
      worktreePath: "/r/wt",
      sessionId: null,
      status: "backlog",
    })
    expect(calls.at(-1)).toEqual({ count: 1, statuses: ["backlog"] })

    await store.update(t.id, { status: "in_progress" })
    expect(calls.at(-1)).toEqual({ count: 1, statuses: ["in_progress"] })

    await store.archive(t.id, "done")
    expect(calls.at(-1)).toEqual({ count: 1, statuses: ["done"] })
  })

  test("listener fires on load() so a re-read picks up external state", async () => {
    // Pre-populate tasks.json on disk so a fresh store sees data on load.
    await mkdir(join(homeDir, ".kobe"), { recursive: true })
    await writeFile(
      join(homeDir, ".kobe", "tasks.json"),
      JSON.stringify(
        {
          version: 1,
          tasks: [
            {
              id: "01HZB000000000000000000000",
              title: "preloaded",
              repo: "/r",
              branch: "kobe/preloaded",
              worktreePath: "/r/wt",
              sessionId: null,
              status: "done",
              createdAt: "2026-05-08T00:00:00.000Z",
              updatedAt: "2026-05-08T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    )

    const store = new TaskIndexStore({ homeDir })
    const calls: number[] = []
    // Subscribe BEFORE load() — listener should fire when load() lands.
    store.subscribe((snap) => calls.push(snap.length))
    expect(calls).toEqual([])
    await store.load()
    expect(calls.at(-1)).toBe(1)
    expect(store.get("01HZB000000000000000000000")?.status).toBe("done")
  })

  test("unsubscribe stops further notifications without affecting other listeners", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const seenA: number[] = []
    const seenB: number[] = []
    const unsubA = store.subscribe((snap) => seenA.push(snap.length))
    store.subscribe((snap) => seenB.push(snap.length))

    await store.create({
      title: "a",
      repo: "/r",
      branch: "kobe/a",
      worktreePath: "/r/wt",
      sessionId: null,
      status: "backlog",
    })
    expect(seenA.at(-1)).toBe(1)
    expect(seenB.at(-1)).toBe(1)

    unsubA()
    await store.create({
      title: "b",
      repo: "/r",
      branch: "kobe/b",
      worktreePath: "/r/wt2",
      sessionId: null,
      status: "backlog",
    })
    // A stopped at 1, B advanced to 2.
    expect(seenA.at(-1)).toBe(1)
    expect(seenB.at(-1)).toBe(2)
  })

  test("a throwing listener does not break the bus for other listeners", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    const seen: number[] = []
    store.subscribe(() => {
      throw new Error("listener boom")
    })
    store.subscribe((snap) => seen.push(snap.length))
    // Suppress console.error for the duration so the failing-listener
    // log doesn't pollute the test output.
    const origConsoleError = console.error
    console.error = () => {}
    try {
      await store.create({
        title: "x",
        repo: "/r",
        branch: "kobe/x",
        worktreePath: "/r/wt",
        sessionId: null,
        status: "backlog",
      })
    } finally {
      console.error = origConsoleError
    }
    expect(seen.at(-1)).toBe(1)
  })

  test("snapshot handed to listener is a defensive copy that the listener can mutate safely", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    let captured: unknown
    store.subscribe((snap) => {
      captured = snap
    })
    await store.create({
      title: "x",
      repo: "/r",
      branch: "kobe/x",
      worktreePath: "/r/wt",
      sessionId: null,
      status: "backlog",
    })
    // Mutating the snapshot must not affect the store's internal state.
    if (Array.isArray(captured)) {
      captured.length = 0
    }
    expect(store.list()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Atomic write — simulated crash recovery
// ---------------------------------------------------------------------------

describe("TaskIndexStore — atomic write & corruption recovery", () => {
  test("load() recovers when tasks.json contains half-written bytes", async () => {
    // Simulate a crash mid-save: a corrupt JSON file at the manifest path.
    await mkdir(join(homeDir, ".kobe"), { recursive: true })
    const partial = '{"version":1,"tasks":[{"id":"01HZ"' // truncated
    await writeFile(join(homeDir, ".kobe", "tasks.json"), partial, "utf8")

    const store = new TaskIndexStore({ homeDir })
    // Important: load() returns the empty fallback rather than throwing.
    // (The product wants kobe to start even if the manifest is fried.)
    const idx = await store.load()
    expect(idx.tasks).toEqual([])
    expect(idx.version).toBe(2)

    // Subsequent operations work; saving overwrites the corrupted file.
    const created = await store.create({
      title: "post-crash",
      repo: "/r",
      branch: "kobe/post-crash",
      worktreePath: "/r/.claude/worktrees/post-crash",
      sessionId: null,
      status: "backlog",
    })
    const onDisk = JSON.parse(await readFile(store.filePath, "utf8"))
    expect(onDisk.tasks).toHaveLength(1)
    expect(onDisk.tasks[0].id).toBe(created.id)
  })

  test("save() leaves no .tmp file behind on the happy path", async () => {
    const store = new TaskIndexStore({ homeDir })
    await store.load()
    await store.create({
      title: "x",
      repo: "/r",
      branch: "kobe/x",
      worktreePath: "/r/x",
      sessionId: null,
      status: "backlog",
    })
    await expect(stat(`${store.filePath}.tmp`)).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("non-object root JSON recovers as empty", async () => {
    await mkdir(join(homeDir, ".kobe"), { recursive: true })
    await writeFile(join(homeDir, ".kobe", "tasks.json"), '"not an object"', "utf8")
    const store = new TaskIndexStore({ homeDir })
    const idx = await store.load()
    expect(idx).toEqual({ version: 2, tasks: [] })
  })

  test("malformed task entries are dropped, valid ones survive", async () => {
    await mkdir(join(homeDir, ".kobe"), { recursive: true })
    const mixed = {
      version: 1,
      tasks: [
        // one valid task
        {
          id: "01HZA",
          title: "ok",
          repo: "/r",
          branch: "kobe/ok",
          worktreePath: "/r/ok",
          sessionId: null,
          status: "backlog",
          createdAt: "2026-05-08T00:00:00Z",
          updatedAt: "2026-05-08T00:00:00Z",
        },
        // missing required fields
        { id: "broken" },
        // wrong status
        {
          id: "01HZB",
          title: "bad",
          repo: "/r",
          branch: "kobe/bad",
          worktreePath: "/r/bad",
          sessionId: null,
          status: "frozen",
          createdAt: "2026-05-08T00:00:00Z",
          updatedAt: "2026-05-08T00:00:00Z",
        },
      ],
    }
    await writeFile(join(homeDir, ".kobe", "tasks.json"), JSON.stringify(mixed), "utf8")
    const store = new TaskIndexStore({ homeDir })
    const idx = await store.load()
    expect(idx.tasks).toHaveLength(1)
    expect(idx.tasks[0]?.id).toBe("01HZA")
  })
})

// ---------------------------------------------------------------------------
// Migration — pre-versioned manifest
// ---------------------------------------------------------------------------

describe("TaskIndexStore — migration", () => {
  test("loads a v0-shaped file (no version field) and writes v2 on save", async () => {
    await mkdir(join(homeDir, ".kobe"), { recursive: true })
    const v0 = {
      // No `version` — this is the pre-stream-C shape we'd see on a manual
      // hand-edited file or an old preview build.
      tasks: [
        {
          id: "01HZA",
          title: "legacy",
          repo: "/r",
          branch: "kobe/legacy",
          worktreePath: "/r/legacy",
          sessionId: null,
          status: "in_progress",
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-01T00:00:00Z",
        },
      ],
    }
    await writeFile(join(homeDir, ".kobe", "tasks.json"), JSON.stringify(v0), "utf8")

    const store = new TaskIndexStore({ homeDir })
    const idx = await store.load()
    expect(idx.version).toBe(2)
    expect(idx.tasks).toHaveLength(1)

    // After any save, the on-disk file should be a v2 manifest.
    await store.update("01HZA", { status: "done" })
    const onDisk = JSON.parse(await readFile(store.filePath, "utf8"))
    expect(onDisk.version).toBe(2)
    expect(onDisk.tasks[0].status).toBe("done")
  })

  test("v1 manifest is migrated to v2 with one synthesized tab", async () => {
    await mkdir(join(homeDir, ".kobe"), { recursive: true })
    const v1 = {
      version: 1,
      tasks: [
        {
          id: "01HZA",
          title: "legacy v1",
          repo: "/r",
          branch: "kobe/legacy",
          worktreePath: "/r/legacy",
          sessionId: "claude-session-uuid-001",
          status: "in_progress",
          createdAt: "2026-05-01T00:00:00Z",
          updatedAt: "2026-05-01T00:00:00Z",
        },
      ],
    }
    await writeFile(join(homeDir, ".kobe", "tasks.json"), JSON.stringify(v1), "utf8")

    const store = new TaskIndexStore({ homeDir })
    const idx = await store.load()
    expect(idx.version).toBe(2)
    expect(idx.tasks).toHaveLength(1)
    const task = idx.tasks[0]
    if (!task) throw new Error("expected task")
    // The synthesized tab carries the v1 sessionId so the task can
    // resume its existing Claude Code session.
    expect(task.tabs).toHaveLength(1)
    expect(task.tabs[0]?.sessionId).toBe("claude-session-uuid-001")
    expect(task.activeTabId).toBe(task.tabs[0]?.id)
    // The deprecated alias mirrors the active tab's session id.
    expect(task.sessionId).toBe("claude-session-uuid-001")

    // Round-trip: write back as v2.
    await store.update("01HZA", { status: "done" })
    const onDisk = JSON.parse(await readFile(store.filePath, "utf8"))
    expect(onDisk.version).toBe(2)
    expect(onDisk.tasks[0].tabs).toHaveLength(1)
    expect(onDisk.tasks[0].activeTabId).toBe(onDisk.tasks[0].tabs[0].id)
  })

  test("future versions (v3+) refuse to load and recover empty", async () => {
    await mkdir(join(homeDir, ".kobe"), { recursive: true })
    await writeFile(
      join(homeDir, ".kobe", "tasks.json"),
      JSON.stringify({ version: 3, tasks: [{ id: "future" }] }),
      "utf8",
    )
    const store = new TaskIndexStore({ homeDir })
    const idx = await store.load()
    expect(idx).toEqual({ version: 2, tasks: [] })
  })
})

// ---------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------

describe("lockfile", () => {
  test("acquire() succeeds once, second acquire() rejects with LockfileError", async () => {
    const lockPath = join(homeDir, ".kobe", "tasks.json.lock")
    await acquire(lockPath)
    try {
      await expect(acquire(lockPath)).rejects.toBeInstanceOf(LockfileError)
    } finally {
      await release(lockPath)
    }
  })

  test("release() then re-acquire() succeeds", async () => {
    const lockPath = join(homeDir, ".kobe", "tasks.json.lock")
    await acquire(lockPath)
    await release(lockPath)
    await acquire(lockPath) // does not throw
    await release(lockPath)
  })

  test("stale lockfile (dead pid) is taken over with a warning", async () => {
    const lockPath = join(homeDir, ".kobe", "tasks.json.lock")
    await mkdir(join(homeDir, ".kobe"), { recursive: true })
    // PID 1 is the init/launchd process — always alive on macOS/Linux —
    // so we use a synthesized "definitely-dead" pid by picking a very
    // large number that is not a real process. Many systems cap PIDs
    // at 2^22; 999_999 is safe but not guaranteed. To avoid flakes,
    // we generate a child, wait for it to die, then re-use its pid.
    // Bun + Node guarantee `child.pid` is unique to that lifetime.
    const { spawn } = await import("node:child_process")
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" })
    const deadPid = child.pid as number
    await new Promise<void>((resolve) => child.once("exit", () => resolve()))
    // Wait long enough for the OS to fully reap before we test liveness;
    // some kernels keep zombies briefly.
    await new Promise((r) => setTimeout(r, 50))
    expect(isProcessAlive(deadPid)).toBe(false)

    await writeFile(lockPath, String(deadPid), "utf8")

    // Capture the warn output so the test still asserts on the side
    // effect (a stderr warning) without polluting test output.
    const originalWarn = console.warn
    const warnings: string[] = []
    console.warn = (msg: string) => {
      warnings.push(String(msg))
    }
    try {
      await acquire(lockPath)
    } finally {
      console.warn = originalWarn
    }
    expect(warnings.some((w) => /stale lockfile/i.test(w))).toBe(true)

    // After takeover, the file holds OUR pid.
    expect((await readFile(lockPath, "utf8")).trim()).toBe(String(process.pid))
    await release(lockPath)
  })

  test("forceTakeover bypasses the live-process check (mocked concurrency win)", async () => {
    // Models the "two processes both try to acquire" scenario without
    // forking: process A holds the lock by writing its own (live) PID.
    // Process B asks to take over with forceTakeover and wins. The
    // real product would never set forceTakeover unconditionally; this
    // is the unit-level proxy for "concurrent acquirer behavior".
    const lockPath = join(homeDir, ".kobe", "tasks.json.lock")
    await acquire(lockPath)
    // Without force: blocked.
    await expect(acquire(lockPath)).rejects.toBeInstanceOf(LockfileError)
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      await acquire(lockPath, { forceTakeover: true }) // wins
    } finally {
      console.warn = originalWarn
    }
    await release(lockPath)
  })

  test("isProcessAlive returns false for nonsense pids", () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
    expect(isProcessAlive(process.pid)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ULID
// ---------------------------------------------------------------------------

describe("ulid", () => {
  test("produces 26 chars from the Crockford base32 alphabet", () => {
    _resetUlidStateForTests()
    for (let i = 0; i < 100; i++) {
      const id = ulid()
      expect(id).toHaveLength(26)
      for (const ch of id) {
        expect(ULID_ALPHABET).toContain(ch)
      }
    }
  })

  test("Crockford alphabet excludes ambiguous characters I, L, O, U", () => {
    expect(ULID_ALPHABET.includes("I")).toBe(false)
    expect(ULID_ALPHABET.includes("L")).toBe(false)
    expect(ULID_ALPHABET.includes("O")).toBe(false)
    expect(ULID_ALPHABET.includes("U")).toBe(false)
    // And it's exactly 32 chars wide.
    expect(ULID_ALPHABET).toHaveLength(32)
  })

  test("monotonic within the same millisecond", () => {
    _resetUlidStateForTests()
    const stampedNow = 1_715_000_000_000 // arbitrary fixed ms
    const ids = Array.from({ length: 10 }, () => ulid(stampedNow))
    const sorted = ids.slice().sort()
    expect(ids).toEqual(sorted)
    // And each id is strictly greater than the previous (no ties).
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true)
    }
  })

  test("timestamp prefix increases when wall-clock advances", () => {
    _resetUlidStateForTests()
    const a = ulid(1_000_000_000_000)
    const b = ulid(1_000_000_000_001)
    // Same length, b sorts after a, and the first 10 chars differ in
    // the expected (later) direction.
    expect(b > a).toBe(true)
    expect(b.slice(0, 10) > a.slice(0, 10)).toBe(true)
  })
})
