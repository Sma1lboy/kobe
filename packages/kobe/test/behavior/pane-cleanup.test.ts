/**
 * Regression pin for the #205 memory-leak class (orphaned pane-process leak,
 * `bc69596`/0.7.59): a killed session's pane leader dies to tmux's default
 * SIGHUP, but an engine CLI that ignores HUP (real `claude` does, so the
 * fake shim in ./harness.ts does too) survives as a CHILD of that pane,
 * reparented to launchd once its parent is gone — invisible to
 * `tmux list-panes` (the session is already gone) but still burning RAM/CPU.
 * Over a hundred such zombies ate ~14 GB / 100%+ CPU in a busy week before
 * `killSession`/`kobe kill-sessions`/`kobe reset` started SIGTERM-ing each
 * pane's whole PROCESS GROUP first. Checking only the pane leader pid (not
 * its group) would miss exactly this child-survives-parent-dies case, so
 * this test expands to the full group via `ps`, the same way `kobe doctor`'s
 * resource snapshot does (doctor-resources.ts).
 */

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

/** `kill(pid, 0)` throws ESRCH once a process is gone; EPERM means it's
 *  alive but owned by someone else (same check as `kobe doctor`). */
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
    // Tasks + Ops + engine at minimum.
    expect(panePids.length).toBeGreaterThanOrEqual(3)

    // Expand each pane leader to its FULL process group — the engine's fake
    // `claude` (ignores HUP) lives as a CHILD of the pane leader, not the
    // leader itself, so checking only `panePids` would miss it surviving.
    const groupPids = paneProcessGroups(psSnapshot(), panePids).map((r) => r.pid)
    expect(groupPids.length).toBeGreaterThanOrEqual(panePids.length)

    // The command a user in #205's position actually runs (also what
    // `kobe reset` and `dev:sandbox:reset` call under the hood): SIGTERM
    // every pane's process group, then kill the tmux server.
    const result = runKobe(["kill-sessions"], env)
    expect(result.code).toBe(0)

    // host-boot.tsx's exit-signal backstop gives itself a 5s grace before
    // `process.exit(0)`; poll instead of a flat sleep so a fast pass isn't
    // slowed down by it.
    const deadline = Date.now() + 15_000
    let stragglers = groupPids.filter(isAlive)
    while (stragglers.length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 300))
      stragglers = groupPids.filter(isAlive)
    }
    expect(stragglers).toEqual([])
  }, 20_000)
})
