import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"

describe("TaskIndexStore self-heal on load", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kobe-heal-"))
    await mkdir(join(home, ".kobe"), { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function writeTasks(tasks: unknown[]): Promise<void> {
    await writeFile(join(home, ".kobe", "tasks.json"), JSON.stringify({ version: 3, tasks }), "utf8")
  }

  function baseRow(over: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "01HXMAINAAAAAAAAAAAAAAAAA",
      title: "kobe",
      repo: "/repo/kobe",
      branch: "",
      worktreePath: "/repo/kobe",
      status: "backlog",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...over,
    }
  }

  it("resets a main task stuck at in_progress back to backlog", async () => {
    await writeTasks([baseRow({ kind: "main", status: "in_progress", archived: false })])
    const store = new TaskIndexStore({ homeDir: home })
    const { tasks } = await store.load()
    expect(tasks[0]?.status).toBe("backlog")
  })

  it("resets a non-archived main task stuck at done back to backlog", async () => {
    await writeTasks([baseRow({ kind: "main", status: "done", archived: false })])
    const store = new TaskIndexStore({ homeDir: home })
    const { tasks } = await store.load()
    expect(tasks[0]?.status).toBe("backlog")
  })

  it("still heals a non-archived done TASK to in_progress (unchanged)", async () => {
    await writeTasks([baseRow({ id: "01HXTASKAAAAAAAAAAAAAAAAA", kind: "task", status: "done", archived: false })])
    const store = new TaskIndexStore({ homeDir: home })
    const { tasks } = await store.load()
    expect(tasks[0]?.status).toBe("in_progress")
  })

  it("leaves an archived done TASK alone", async () => {
    await writeTasks([baseRow({ id: "01HXTASKBBBBBBBBBBBBBBBBB", kind: "task", status: "done", archived: true })])
    const store = new TaskIndexStore({ homeDir: home })
    const { tasks } = await store.load()
    expect(tasks[0]?.status).toBe("done")
  })
})

describe("TaskIndexStore vendor coercion on load", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kobe-vendor-"))
    await mkdir(join(home, ".kobe"), { recursive: true })
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function writeTasks(tasks: unknown[]): Promise<void> {
    await writeFile(join(home, ".kobe", "tasks.json"), JSON.stringify({ version: 3, tasks }), "utf8")
  }

  function taskRow(over: Record<string, unknown>): Record<string, unknown> {
    return {
      id: "01HXTASKAAAAAAAAAAAAAAAAA",
      title: "task",
      repo: "/repo",
      branch: "feature",
      worktreePath: "/repo/feature",
      status: "backlog",
      kind: "task",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...over,
    }
  }

  async function loadVendor(over: Record<string, unknown>): Promise<string | undefined> {
    await writeTasks([taskRow(over)])
    const store = new TaskIndexStore({ homeDir: home })
    const { tasks } = await store.load()
    return tasks[0]?.vendor
  }

  it("preserves a copilot vendor", async () => {
    expect(await loadVendor({ vendor: "copilot" })).toBe("copilot")
  })

  it("preserves a built-in codex vendor", async () => {
    expect(await loadVendor({ vendor: "codex" })).toBe("codex")
  })

  it("preserves a custom (user-registered) engine vendor", async () => {
    expect(await loadVendor({ vendor: "my-engine" })).toBe("my-engine")
  })

  it("falls back to claude when vendor is absent", async () => {
    expect(await loadVendor({})).toBe("claude")
  })

  it("falls back to claude for an empty or non-string vendor", async () => {
    expect(await loadVendor({ vendor: "" })).toBe("claude")
    expect(await loadVendor({ vendor: 42 })).toBe("claude")
  })
})

describe("TaskIndexStore task ordering", () => {
  let home: string

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "kobe-order-"))
  })

  afterEach(async () => {
    await rm(home, { recursive: true, force: true })
  })

  async function createStore(): Promise<TaskIndexStore> {
    const store = new TaskIndexStore({ homeDir: home })
    await store.load()
    return store
  }

  it("moves a task within a caller-provided ordering group", async () => {
    const store = await createStore()
    const a = await store.create({
      title: "a",
      repo: "/repo",
      branch: "a",
      worktreePath: "/repo/a",
      status: "backlog",
    })
    const pinned = await store.create({
      title: "pinned",
      repo: "/repo",
      branch: "pinned",
      worktreePath: "/repo/pinned",
      status: "backlog",
      pinned: true,
    })
    const b = await store.create({
      title: "b",
      repo: "/repo",
      branch: "b",
      worktreePath: "/repo/b",
      status: "backlog",
    })

    await store.move(b.id, -1, [String(a.id), String(b.id)])

    expect(store.list().map((t) => t.id)).toEqual([b.id, a.id, pinned.id])
  })

  it("keeps boundary moves as no-ops", async () => {
    const store = await createStore()
    const a = await store.create({
      title: "a",
      repo: "/repo",
      branch: "a",
      worktreePath: "/repo/a",
      status: "backlog",
    })
    const b = await store.create({
      title: "b",
      repo: "/repo",
      branch: "b",
      worktreePath: "/repo/b",
      status: "backlog",
    })

    await store.move(a.id, -1, [String(a.id), String(b.id)])

    expect(store.list().map((t) => t.id)).toEqual([a.id, b.id])
  })
})
