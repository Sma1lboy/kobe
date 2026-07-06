import { spawnSync } from "node:child_process"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { paneProcessGroups, parsePsRows } from "../../src/cli/doctor-resources.ts"
import {
  type BehaviorEnv,
  makeBehaviorEnv,
  makeScratchRepo,
  runKobe,
  tmux,
  tmuxAvailable,
  tmuxInner,
  waitForScreen,
} from "./harness.ts"

const SESSION = "leak-check"

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function psSnapshot(): ReturnType<typeof parsePsRows> {
  const r = spawnSync("ps", ["-axo", "pid,pgid,rss,comm"], { encoding: "utf8" })
  return parsePsRows(r.stdout ?? "")
}

describe.skipIf(!tmuxAvailable())("pane-process cleanup on `kobe kill-sessions` (#205 regression)", () => {
  let env: BehaviorEnv

  beforeAll(async () => {
    env = await makeBehaviorEnv()
    const repo = await makeScratchRepo(env)
    const boot = tmux(env, "new-session", "-d", "-x", "180", "-y", "45", "-s", SESSION, `cd ${repo} && kobe`)
    expect(boot.code).toBe(0)
    await waitForScreen(env, SESSION, (s) => s.includes("fake-claude ready"), 45_000)
  }, 60_000)

  afterAll(async () => {
    await env.dispose()
  })

  it("leaves no surviving process in any pane's group after the exit grace", async () => {
    const panePids = tmuxInner(env, "list-panes", "-a", "-F", "#{pane_pid}")
      .stdout.split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 1)
    expect(panePids.length).toBeGreaterThanOrEqual(3)

    const groupPids = paneProcessGroups(psSnapshot(), panePids).map((r) => r.pid)
    expect(groupPids.length).toBeGreaterThanOrEqual(panePids.length)

    const result = runKobe(["kill-sessions"], env)
    expect(result.code).toBe(0)

    const deadline = Date.now() + 15_000
    let stragglers = groupPids.filter(isAlive)
    while (stragglers.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      stragglers = groupPids.filter(isAlive)
    }
    expect(stragglers).toEqual([])
  }, 20_000)
})
