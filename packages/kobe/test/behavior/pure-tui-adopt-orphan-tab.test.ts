/**
 * Regression pin (2026-08-12, follow-up to issue #20): a live pty session the
 * persisted tab snapshot doesn't list must be ADOPTED into that snapshot, not
 * only reported.
 *
 * Reported-only was the state the owner hit on 0.8.77: three tasks had live
 * `claude` sessions the sidebar drew as `⚠` rows, and a row that is in no tab
 * state can't be opened, focused or closed — engines he could neither read
 * nor end. The pin drives the real TUI against a divergence built the way the
 * field one arose (the session outlives its snapshot entry) and asserts the
 * snapshot names the live tab again.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BehaviorEnv, DIST_ROVE_CLI, loadNodePty, makeBehaviorEnv, makeScratchRepo, runRove } from "./harness.ts"

const nodePty = await loadNodePty()

describe.skipIf(!nodePty)("Pure TUI adopts unregistered live sessions (behavior)", () => {
  let env: BehaviorEnv
  let repo: string
  let statePath: string
  let taskId: string

  const readState = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>

  beforeAll(async () => {
    env = await makeBehaviorEnv()
    repo = await makeScratchRepo(env)
    const stateDir = join(env.home, ".config", "rove")
    await mkdir(stateDir, { recursive: true })
    statePath = join(stateDir, "state.json")
    await writeFile(statePath, JSON.stringify({ onboarded: true }))

    // `--prompt` takes the headless launch path: worktree + hosted engine
    // session under `<taskId>::tab-1`, plus the snapshot the CLI writes.
    const add = runRove(["api", "add", "--repo", repo, "--prompt", "hello"], env)
    expect(add.code, add.stderr).toBe(0)
    taskId = (JSON.parse(add.stdout) as { task: { id: string } }).task.id
  }, 120_000)

  afterAll(async () => {
    await env.dispose()
  })

  it("writes the live session back into the tab snapshot the TUI renders from", async () => {
    if (!nodePty) throw new Error("unreachable: suite is skipped without node-pty")
    const key = `terminalTabs.${taskId}`

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const sessions = JSON.parse(runRove(["api", "pty-list"], env).stdout) as {
        sessions?: { key: string; alive?: boolean }[]
      }
      if (sessions.sessions?.some((s) => s.key === `${taskId}::tab-1` && s.alive)) break
      await new Promise((resolve) => setTimeout(resolve, 250))
    }

    // The divergence, in the shape the field one had: the snapshot names a
    // DIFFERENT tab while the engine keeps running under tab-1 — what a tab
    // closed while its task was unmounted (the kill never reached the host)
    // leaves behind. The session is alive and no row names it.
    const state = await readState()
    expect(state[key]).toBeDefined()
    state[key] = {
      tabs: [{ kind: "engine", id: "tab-9", title: null, ordinal: 9 }],
      activeId: "tab-9",
      nextOrdinal: 10,
    }
    await writeFile(statePath, JSON.stringify(state))

    // The host-session poll is off under a test RUNNER (`use-host-sessions`
    // must not pin a shared client inside bun-test), and this child inherits
    // vitest's markers. It is a real TUI in its own process, so clear them.
    const { VITEST, NODE_ENV, BUN_TEST, ...tuiEnv } = env.env as Record<string, string>
    const child = nodePty.spawn("bun", [DIST_ROVE_CLI], {
      cols: 140,
      rows: 40,
      cwd: repo,
      env: tuiEnv,
    })
    try {
      // The sidebar polls the host every 2s; adoption lands on a poll it can
      // reconcile, so wait on the STATE, not on a frame.
      const adoptDeadline = Date.now() + 30_000
      let adopted: { tabs?: { id: string }[] } | undefined
      while (Date.now() < adoptDeadline) {
        adopted = (await readState())[key] as { tabs?: { id: string }[] } | undefined
        if (adopted?.tabs?.some((tab) => tab.id === "tab-1")) break
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      expect(adopted?.tabs?.map((tab) => tab.id)).toContain("tab-1")
    } finally {
      child.kill()
    }
  }, 90_000)
})
