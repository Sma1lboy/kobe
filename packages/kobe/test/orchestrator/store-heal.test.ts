import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"

/**
 * Self-heal-on-load coercion (`coerceTask`). The bug it guards (the kobe
 * project stuck showing "working"): a `main` (project-root) task has NO
 * session lifecycle that maintains its status, so an old auto-done flip
 * plus the done→in_progress heal left the project permanently in_progress,
 * which the Tasks pane reads as the "working" chip. A main row must heal to
 * a neutral `backlog`; only real tasks keep the done→in_progress heal.
 */
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
