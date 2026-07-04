/**
 * `kobe api` black-box task + issue lifecycle — drives the CLI verb surface
 * the way an agent scripting kobe from a shell would, with no TUI/tmux-outer
 * session involved. Pins:
 *
 *   - `add --prompt` materializes the worktree on disk (`ensure-worktree`'s
 *     contract) AND starts the task's tmux session (`ensureSession`'s
 *     four-pane workspace: tasks/claude/ops/shell — `docs/ARCHITECTURE.md`'s
 *     "Task = worktree + engine session + branch" unit, verified end to end).
 *   - `archive` tears the session down via `killSession`'s pane-process-group
 *     SIGTERM (the same #205 cleanup path `pane-cleanup.test.ts` pins for
 *     `kill-sessions`), and is reflected in `get-task`/`list` (non-destructive:
 *     the task row survives with `archived: true`).
 *   - the daemon-owned issue store round-trips create → list → set-status
 *     (`docs/WORK-TRACKING.md`'s backlog, driven via `kobe api issue-*`).
 *
 * One `beforeAll` boot (no tmux-outer session needed here — `kobe api`
 * commands are piped CLI runs that auto-start the daemon and, for `add
 * --prompt`, the task's own tmux session on `env.socket`), all assertions
 * share it per docs/HARNESS.md's "one boot, multiple assertions" budget.
 */

import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { paneProcessGroups, parsePsRows } from "../../src/cli/doctor-resources.ts"
import { type BehaviorEnv, makeBehaviorEnv, makeScratchRepo, runKobe, tmuxAvailable, tmuxInner } from "./harness.ts"

interface AddResult {
  taskId: string
  task: { worktreePath: string; archived: boolean; status: string }
  started: boolean
  engineReady: boolean
  session: string
}

interface GetTaskResult {
  task: { archived: boolean; status: string }
  running: boolean
}

interface ListResult {
  tasks: { id: string; archived: boolean }[]
}

interface IssueListResult {
  issues: { id: number; title: string; status: string }[]
}

/** Same liveness probe `pane-cleanup.test.ts` uses: ESRCH gone, EPERM alive-but-foreign. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((r) => setTimeout(r, 300))
  }
  return predicate()
}

describe.skipIf(!tmuxAvailable())("kobe api task + issue lifecycle (behavior)", () => {
  let env: BehaviorEnv
  let repo: string

  beforeAll(async () => {
    env = await makeBehaviorEnv()
    repo = await makeScratchRepo(env)
  }, 30_000)

  afterAll(async () => {
    await env.dispose()
  })

  let taskId: string
  let session: string
  let worktreePath: string

  it("`add --prompt` materializes the worktree and starts a live 4-pane tmux session", () => {
    const r = runKobe(["api", "add", "--repo", repo, "--prompt", "hello from behavior suite", "--pretty"], env)
    expect(r.code).toBe(0)
    const res = JSON.parse(r.stdout) as AddResult
    taskId = res.taskId
    session = res.session
    worktreePath = res.task.worktreePath

    expect(res.started).toBe(true)
    expect(res.engineReady).toBe(true)
    expect(session).toBe(`kobe-${taskId}`)
    expect(res.task.archived).toBe(false)

    // The worktree the task/orchestrator promised is a real directory on disk.
    expect(existsSync(worktreePath)).toBe(true)

    // The session is alive on kobe's OWN tmux socket with the full workspace.
    const sessions = tmuxInner(env, "list-sessions", "-F", "#{session_name}").stdout
    expect(sessions.split("\n")).toContain(session)

    const paneRows = tmuxInner(env, "list-panes", "-t", `=${session}`, "-F", "#{@kobe_role}")
      .stdout.split("\n")
      .filter(Boolean)
    expect(new Set(paneRows)).toEqual(new Set(["tasks", "claude", "ops", "shell"]))

    // The engine pane is the fake-claude shim, already up (add awaited engineReady).
    const claudePane = tmuxInner(env, "list-panes", "-t", `=${session}`, "-F", "#{pane_id}\t#{@kobe_role}")
      .stdout.split("\n")
      .find((l) => l.endsWith("\tclaude"))
      ?.split("\t")[0]
    expect(claudePane).toBeTruthy()
    const capture = tmuxInner(env, "capture-pane", "-t", claudePane as string, "-p").stdout
    expect(capture).toContain("fake-claude ready")
  })

  it("`archive` kills the session's full pane-process groups and flips `archived` in get-task/list", async () => {
    const panePids = tmuxInner(env, "list-panes", "-t", `=${session}`, "-F", "#{pane_pid}")
      .stdout.split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 1)
    expect(panePids.length).toBeGreaterThanOrEqual(4)

    const psOut = spawnSync("ps", ["-axo", "pid,pgid,rss,comm"], { encoding: "utf8" }).stdout ?? ""
    const groupPids = paneProcessGroups(parsePsRows(psOut), panePids).map((r) => r.pid)
    expect(groupPids.length).toBeGreaterThanOrEqual(panePids.length)

    const r = runKobe(["api", "archive", "--task-id", taskId, "--pretty"], env)
    expect(r.code).toBe(0)

    // Session gone from kobe's tmux socket (killSession's SIGTERM-the-group path).
    const sessionGone = await waitUntil(() => tmuxInner(env, "has-session", "-t", `=${session}`).code !== 0, 15_000)
    expect(sessionGone).toBe(true)

    // No pane-group process outlives the archive — the #205 leak class.
    const noStragglers = await waitUntil(() => groupPids.every((pid) => !isAlive(pid)), 15_000)
    expect(noStragglers).toBe(true)

    const getRes = JSON.parse(
      runKobe(["api", "get-task", "--task-id", taskId, "--pretty"], env).stdout,
    ) as GetTaskResult
    expect(getRes.task.archived).toBe(true)
    expect(getRes.running).toBe(false)

    const listRes = JSON.parse(runKobe(["api", "list", "--pretty"], env).stdout) as ListResult
    const row = listRes.tasks.find((t) => t.id === taskId)
    expect(row?.archived).toBe(true)

    // Non-destructive: the worktree the first assertion found on disk is untouched.
    expect(existsSync(worktreePath)).toBe(true)
  }, 30_000)

  it("issue store round-trips create -> list -> set-status", () => {
    const created = JSON.parse(
      runKobe(["api", "issue-create", "--repo", repo, "--title", "behavior suite issue", "--pretty"], env).stdout,
    ) as IssueListResult
    const issue = created.issues.find((i) => i.title === "behavior suite issue")
    expect(issue).toBeTruthy()
    expect(issue?.status).toBe("open")
    const id = issue?.id as number

    const listed = JSON.parse(runKobe(["api", "issue-list", "--repo", repo, "--pretty"], env).stdout) as IssueListResult
    expect(listed.issues.some((i) => i.id === id && i.title === "behavior suite issue")).toBe(true)

    const setStatus = runKobe(
      ["api", "issue-set-status", "--repo", repo, "--id", String(id), "--status", "done", "--pretty"],
      env,
    )
    expect(setStatus.code).toBe(0)

    const after = JSON.parse(runKobe(["api", "issue-list", "--repo", repo, "--pretty"], env).stdout) as IssueListResult
    expect(after.issues.find((i) => i.id === id)?.status).toBe("done")
  })
})
