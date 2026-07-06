import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runAutoTitlePass } from "@sma1lboy/kobe-daemon/daemon/auto-title-poller"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { Orchestrator, PLACEHOLDER_TASK_TITLE } from "../../src/orchestrator/core.ts"
import { TaskIndexStore } from "../../src/orchestrator/index/store.ts"
import { GitWorktreeManager } from "../../src/orchestrator/worktree/manager.ts"

let tmpRoot: string
let store: TaskIndexStore
let orch: Orchestrator

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-autotitle-"))
  store = new TaskIndexStore({ homeDir: path.join(tmpRoot, "home") })
  await store.load()
  orch = new Orchestrator({ store, worktrees: new GitWorktreeManager() })
})

afterEach(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {}
})

async function makeTask(opts: { title?: string; worktree?: string }) {
  const task = await orch.createTask({ repo: "/repo", title: opts.title })
  if (opts.worktree !== undefined) await store.update(task.id, { worktreePath: opts.worktree })
  return task.id
}

describe("runAutoTitlePass", () => {
  test("renames only placeholder tasks that have a worktree", async () => {
    const placeholderWithWorktree = await makeTask({ worktree: "/wt/a" })
    const alreadyNamed = await makeTask({ title: "Fix login 500", worktree: "/wt/b" })
    const placeholderNoWorktree = await makeTask({ worktree: undefined })

    const renamed = await runAutoTitlePass(orch, async (worktree) => `title-for-${worktree}`)

    expect(renamed.map((r) => r.id)).toEqual([placeholderWithWorktree])
    expect(renamed[0]?.title).toBe("title-for-/wt/a")
    expect(orch.getTask(placeholderWithWorktree)?.title).toBe("title-for-/wt/a")
    expect(orch.getTask(alreadyNamed)?.title).toBe("Fix login 500")
    expect(orch.getTask(placeholderNoWorktree)?.title).toBe(PLACEHOLDER_TASK_TITLE)
  })

  test("skips archived tasks even when still placeholder", async () => {
    const archived = await makeTask({ worktree: "/wt/arch" })
    await store.update(archived, { archived: true })
    const active = await makeTask({ worktree: "/wt/active" })

    const renamed = await runAutoTitlePass(orch, async (worktree) => `title-for-${worktree}`)

    expect(renamed.map((r) => r.id)).toEqual([active])
    expect(orch.getTask(archived)?.title).toBe(PLACEHOLDER_TASK_TITLE)
  })

  test("leaves the placeholder when the deriver yields no title", async () => {
    const id = await makeTask({ worktree: "/wt/a" })
    const renamed = await runAutoTitlePass(orch, async () => "")
    expect(renamed).toEqual([])
    expect(orch.getTask(id)?.title).toBe(PLACEHOLDER_TASK_TITLE)
  })

  test("a failing task does not block the others", async () => {
    const boom = await makeTask({ worktree: "/wt/boom" })
    const ok = await makeTask({ worktree: "/wt/ok" })

    const renamed = await runAutoTitlePass(orch, async (worktree) => {
      if (worktree === "/wt/boom") throw new Error("disk read failed")
      return `title-for-${worktree}`
    })

    expect(renamed.map((r) => r.id)).toEqual([ok])
    expect(orch.getTask(boom)?.title).toBe(PLACEHOLDER_TASK_TITLE)
    expect(orch.getTask(ok)?.title).toBe("title-for-/wt/ok")
  })

  test("does not overwrite a manual rename that lands during the disk read", async () => {
    const id = await makeTask({ worktree: "/wt/a" })

    const renamed = await runAutoTitlePass(orch, async () => {
      await orch.setTitle(id, "User chose this")
      return "derived-title"
    })

    expect(renamed).toEqual([])
    expect(orch.getTask(id)?.title).toBe("User chose this")
  })
})
