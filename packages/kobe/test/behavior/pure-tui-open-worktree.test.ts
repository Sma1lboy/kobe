/**
 * Regression pin for the v0.7.98 Workspace Host gap: the keymap advertised
 * editor-open actions, but the host never registered their handlers. Drive
 * the built Pure TUI and prove both sidebar `o` and global prefix-o launch the
 * selected task worktree through the detected editor.
 */

import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BehaviorEnv, DIST_CLI, makeBehaviorEnv, makeScratchRepo, runKobe } from "./harness.ts"

const nodePty = await import("node-pty").then(
  (mod) => mod,
  () => null,
)

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

describe.skipIf(!nodePty)("Pure TUI open-worktree keys (behavior)", () => {
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
  })

  afterAll(async () => {
    await env.dispose()
  })

  it("opens the selected worktree with sidebar o and global ctrl+a then o", async () => {
    if (!nodePty) throw new Error("unreachable: suite is skipped without node-pty")
    const child = nodePty.spawn("bun", [DIST_CLI], {
      cols: 140,
      rows: 40,
      cwd: repo,
      env: env.env as Record<string, string>,
    })
    let raw = ""
    const data = child.onData((chunk) => {
      raw += chunk
    })
    try {
      const deadline = Date.now() + 30_000
      while (!raw.includes("PROJECTS") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(raw).toContain("PROJECTS")

      child.write("o")
      expect(await waitForInvocations(marker, 1)).toEqual([repo])

      child.write("\x01o")
      expect(await waitForInvocations(marker, 2)).toEqual([repo, repo])
    } finally {
      data.dispose()
      child.kill()
    }
  }, 45_000)
})
