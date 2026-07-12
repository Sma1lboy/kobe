/**
 * Black-box proof that API automation creates and tears down the same hosted
 * engine session the PureTUI workspace uses, without a mounted TUI.
 */

import { existsSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BehaviorEnv, makeBehaviorEnv, makeScratchRepo, runKobe } from "./harness.ts"

interface AddResult {
  taskId: string
  task: { worktreePath: string; archived: boolean }
  session: string
  started: boolean
  engineReady: boolean
  delivered: boolean
}

interface PtyListResult {
  sessions: Array<{ key: string; alive: boolean; command: string[] }>
}

interface GetTaskResult {
  task: { archived: boolean }
  running: boolean
}

describe("kobe api hosted PTY lifecycle (behavior)", () => {
  let env: BehaviorEnv
  let repo: string
  let taskId = ""
  let session = ""
  let worktreePath = ""

  beforeAll(async () => {
    env = await makeBehaviorEnv()
    repo = await makeScratchRepo(env)
  }, 30_000)

  afterAll(async () => {
    await env.dispose()
  })

  it("add --prompt materializes a worktree and auto-starts the canonical engine session", () => {
    const result = runKobe(["api", "add", "--repo", repo, "--prompt", "hello from behavior", "--pretty"], env)
    expect(result.code).toBe(0)
    const added = JSON.parse(result.stdout) as AddResult
    taskId = added.taskId
    session = added.session
    worktreePath = added.task.worktreePath

    expect(added.started).toBe(true)
    expect(added.engineReady).toBe(true)
    expect(added.delivered).toBe(true)
    expect(session).toBe(`${taskId}::tab-1`)
    expect(existsSync(worktreePath)).toBe(true)

    const listed = runKobe(["api", "pty-list", "--pretty"], env)
    expect(listed.code).toBe(0)
    const sessions = (JSON.parse(listed.stdout) as PtyListResult).sessions
    expect(sessions).toContainEqual(expect.objectContaining({ key: session, alive: true }))
  }, 30_000)

  it("send reuses the canonical session and archive tears it down", () => {
    const sent = runKobe(["api", "send", "--task-id", taskId, "--prompt", "follow-up", "--pretty"], env)
    expect(sent.code).toBe(0)
    const afterSend = JSON.parse(runKobe(["api", "pty-list", "--pretty"], env).stdout) as PtyListResult
    expect(afterSend.sessions.filter((entry) => entry.key === session && entry.alive)).toHaveLength(1)

    const archived = runKobe(["api", "archive", "--task-id", taskId, "--pretty"], env)
    expect(archived.code).toBe(0)
    const task = JSON.parse(runKobe(["api", "get-task", "--task-id", taskId, "--pretty"], env).stdout) as GetTaskResult
    expect(task.task.archived).toBe(true)
    expect(task.running).toBe(false)
    expect(existsSync(worktreePath)).toBe(true)
  }, 30_000)
})
