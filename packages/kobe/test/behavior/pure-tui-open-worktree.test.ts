/**
 * Regression pin for the v0.7.98 Workspace Host gap: the keymap advertised
 * editor-open actions, but the host never registered their handlers. Drive
 * the built Pure TUI and prove both sidebar `o` and global prefix-o launch the
 * selected task worktree through the detected editor.
 */

import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  type BehaviorEnv,
  makeBehaviorEnv,
  makeScratchRepo,
  runKobe,
  tmux,
  tmuxAvailable,
  waitForScreen,
} from "./harness.ts"

const SESSION = "pure-tui-open-worktree"

async function waitForInvocations(marker: string, count: number): Promise<string[]> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const lines = await readFile(marker, "utf8").then(
      (text) => text.trim().split("\n").filter(Boolean),
      () => [],
    )
    if (lines.length >= count) return lines
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return []
}

describe.skipIf(!tmuxAvailable())("Pure TUI open-worktree keys (behavior)", () => {
  let env: BehaviorEnv
  let repo: string
  let marker: string

  beforeAll(async () => {
    env = await makeBehaviorEnv()
    repo = await makeScratchRepo(env)
    marker = join(env.home, "editor-opens.log")
    const codeShim = join(env.bin, "code")
    await writeFile(codeShim, `#!/bin/sh\nprintf '%s\\n' "$1" >> "${marker}"\n`)
    await chmod(codeShim, 0o755)
    const add = runKobe(["add", repo], env)
    expect(add.code).toBe(0)
    const boot = tmux(env, "new-session", "-d", "-x", "140", "-y", "40", "-s", SESSION, `cd ${repo} && KOBE_TUI=1 kobe`)
    expect(boot.code).toBe(0)
  })

  afterAll(async () => {
    await env.dispose()
  })

  it("opens the selected worktree with sidebar o and global ctrl+a then o", async () => {
    const screen = await waitForScreen(
      env,
      SESSION,
      (value) => value.includes("KOBE") && value.includes("PROJECTS"),
      30_000,
    )
    expect(screen).toContain("PROJECTS")

    tmux(env, "send-keys", "-t", SESSION, "o")
    expect(await waitForInvocations(marker, 1)).toEqual([repo])

    tmux(env, "send-keys", "-t", SESSION, "C-a", "o")
    expect(await waitForInvocations(marker, 2)).toEqual([repo, repo])
  }, 45_000)
})
