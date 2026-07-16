/**
 * TaskIndexStore edges not covered by the concurrency / heal / reorder suites:
 * load() recovery (missing file, corrupt JSON, unsupported version, non-object
 * root, malformed rows), prStatus load coercion, the loaded-guard, update/move
 * error paths, the subscribe contract (eager fire, unsubscribe, throwing
 * listener isolation), and the archive/remove conveniences.
 *
 * Why they matter: load() recovery is the difference between "kobe boots with
 * an empty sidebar and a warning" and "kobe crashes on a half-written
 * tasks.json" — the file is written by multiple processes, so every corrupt
 * shape here is one a real crash can produce.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"

let home: string
let store: TaskIndexStore

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "kobe-store-edge-"))
  store = new TaskIndexStore({ homeDir: home })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function writeManifest(content: string): Promise<void> {
  await rm(store.filePath, { force: true })
  await writeFile(store.filePath, content, "utf8")
}

async function primeDir(): Promise<void> {
  // Create <home>/.kobe by letting the store write once.
  await store.load()
  await store.create({
    repo: "/r",
    title: "seed",
    branch: "",
    worktreePath: "",
    status: "backlog",
    kind: "task",
    vendor: "claude",
  })
}

describe("load() recovery", () => {
  it("a missing file loads as an empty index", async () => {
    const index = await store.load()
    expect(index.tasks).toEqual([])
    expect(store.list()).toEqual([])
  })

  it("corrupt JSON recovers empty with a warning, leaving the file in place", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await primeDir()
    await writeManifest("{ not json !!!")
    const index = await store.load()
    expect(index.tasks).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("corrupted"))
    warn.mockRestore()
  })

  it("an unsupported version recovers empty with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await primeDir()
    await writeManifest(JSON.stringify({ version: 99, tasks: [] }))
    expect((await store.load()).tasks).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unsupported version"))
    warn.mockRestore()
  })

  it("a non-object root (array) recovers empty with a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await primeDir()
    await writeManifest(JSON.stringify([1, 2, 3]))
    expect((await store.load()).tasks).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not an object"))
    warn.mockRestore()
  })

  it("drops malformed task rows but keeps the valid ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await primeDir()
    const good = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      title: "ok",
      repo: "/r",
      branch: "b",
      worktreePath: "",
      status: "backlog",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    await writeManifest(
      JSON.stringify({
        version: 3,
        tasks: [good, { id: 42 }, "nonsense", { ...good, id: "x", status: "bogus-status" }],
      }),
    )
    const index = await store.load()
    expect(index.tasks.map((t) => t.title)).toEqual(["ok"])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dropping malformed task entry"))
    warn.mockRestore()
  })

  it("coerces a valid persisted prStatus and drops an invalid one", async () => {
    await primeDir()
    const base = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      title: "ok",
      repo: "/r",
      branch: "b",
      worktreePath: "",
      status: "backlog",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    await writeManifest(
      JSON.stringify({
        version: 3,
        tasks: [
          { ...base, prStatus: { provider: "github", lifecycle: "open", checkState: "passing", number: 12 } },
          { ...base, id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", prStatus: { provider: "sourcehut" } },
        ],
      }),
    )
    const [withPr, withoutPr] = (await store.load()).tasks
    expect(withPr?.prStatus).toMatchObject({ provider: "github", number: 12 })
    expect(withoutPr?.prStatus).toBeUndefined()
  })

  it("persists a fan-out groupId across reload and drops non-string values", async () => {
    await primeDir()
    const base = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      title: "ok",
      repo: "/r",
      branch: "b",
      worktreePath: "",
      status: "backlog",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    await writeManifest(
      JSON.stringify({
        version: 3,
        tasks: [
          { ...base, groupId: "01GROUPULID" },
          { ...base, id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", groupId: 42 },
        ],
      }),
    )
    const [grouped, malformed] = (await store.load()).tasks
    expect(grouped?.groupId).toBe("01GROUPULID")
    expect(malformed?.groupId).toBeUndefined()
  })

  it("preserves valid deletion state and drops malformed deletion state", async () => {
    await primeDir()
    const base = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      title: "ok",
      repo: "/r",
      branch: "b",
      worktreePath: "/wt/b",
      status: "backlog",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    await writeManifest(
      JSON.stringify({
        version: 3,
        tasks: [
          {
            ...base,
            deletion: { phase: "running", force: true, requestedAt: "2026-07-15T00:00:00.000Z" },
          },
          { ...base, id: "01ARZ3NDEKTSV4RRFFQ69G5FB0", deletion: { phase: "wat", force: "yes" } },
        ],
      }),
    )
    const [valid, malformed] = (await store.load()).tasks
    expect(valid?.deletion).toEqual({
      phase: "running",
      force: true,
      requestedAt: "2026-07-15T00:00:00.000Z",
    })
    expect(malformed?.deletion).toBeUndefined()
  })
})

describe("loaded guard", () => {
  it("every read/mutation before load() throws the call-load-first error", () => {
    expect(() => store.list()).toThrow(/call load\(\)/)
    expect(() => store.get("x")).toThrow(/call load\(\)/)
  })
})

describe("update / move / remove edges", () => {
  beforeEach(async () => {
    await store.load()
  })

  it("update throws for an unknown id", async () => {
    await expect(store.update("missing", { title: "x" })).rejects.toThrow(/task not found/)
  })

  it("update refuses to change id/createdAt but bumps updatedAt", async () => {
    const t = await store.create({
      repo: "/r",
      title: "a",
      branch: "",
      worktreePath: "",
      status: "backlog",
      kind: "task",
      vendor: "claude",
    })
    const next = await store.update(t.id, {
      id: "hijacked",
      createdAt: "1999-01-01T00:00:00.000Z",
      title: "b",
    } as never)
    expect(next.id).toBe(t.id)
    expect(next.createdAt).toBe(t.createdAt)
    expect(next.title).toBe("b")
    expect(next.updatedAt >= t.updatedAt).toBe(true)
  })

  it("move throws for an unknown id and for an id outside the given group", async () => {
    const t = await store.create({
      repo: "/r",
      title: "a",
      branch: "",
      worktreePath: "",
      status: "backlog",
      kind: "task",
      vendor: "claude",
    })
    await expect(store.move("missing", 1)).rejects.toThrow(/task not found/)
    await expect(store.move(t.id, 1, ["other-id"])).rejects.toThrow(/not movable/)
  })

  it("remove is a silent no-op for an unknown id", async () => {
    await expect(store.remove("missing")).resolves.toBeUndefined()
  })
})

describe("subscribe contract", () => {
  it("fires eagerly with the current snapshot when already loaded, and unsubscribes cleanly", async () => {
    await store.load()
    const seen: number[] = []
    const unsub = store.subscribe((snapshot) => {
      seen.push(snapshot.length)
    })
    expect(seen).toEqual([0]) // eager fire on subscribe
    await store.create({
      repo: "/r",
      title: "a",
      branch: "",
      worktreePath: "",
      status: "backlog",
      kind: "task",
      vendor: "claude",
    })
    expect(seen.at(-1)).toBe(1)
    unsub()
    await store.create({
      repo: "/r",
      title: "b",
      branch: "",
      worktreePath: "",
      status: "backlog",
      kind: "task",
      vendor: "claude",
    })
    expect(seen.at(-1)).toBe(1)
  })

  it("does not fire eagerly before load(), then delivers the load() snapshot", async () => {
    const seen: number[] = []
    store.subscribe((snapshot) => {
      seen.push(snapshot.length)
    })
    expect(seen).toEqual([])
    await store.load()
    expect(seen).toEqual([0])
  })

  it("a throwing listener is isolated — other listeners still get notified", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    await store.load()
    store.subscribe(() => {
      throw new Error("bad listener")
    })
    const seen: number[] = []
    store.subscribe((snapshot) => {
      seen.push(snapshot.length)
    })
    await store.create({
      repo: "/r",
      title: "a",
      branch: "",
      worktreePath: "",
      status: "backlog",
      kind: "task",
      vendor: "claude",
    })
    expect(seen.at(-1)).toBe(1)
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
