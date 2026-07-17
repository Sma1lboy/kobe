/**
 * Regression pin for the v0.7.98 Workspace Host gap: the keymap advertised
 * editor-open actions, but the host never registered their handlers. Drive
 * the built Pure TUI and prove both sidebar `o` and global prefix-o launch the
 * selected task worktree through the detected editor.
 */

import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type BehaviorEnv, DIST_CLI, makeBehaviorEnv, makeScratchRepo, runKobe } from "./harness.ts"

const nodePty = await import("node-pty").then(
  (mod) => mod,
  () => null,
)

async function readInvocations(marker: string): Promise<string[]> {
  return readFile(marker, "utf8").then(
    (text) => text.trim().split("\n").filter(Boolean),
    () => [],
  )
}

/**
 * Press `keys` REPEATEDLY until the editor shim records more invocations
 * than `base`. A single early keypress can land before the sidebar's
 * async selection adoption makes the `o` handler live (the handler gates
 * on `selectedId`) — on a slow CI runner that keypress is silently
 * dropped and a fixed one-shot wait then flakes (the recurring
 * `expected [] to deeply equal [repo]` failure). Retrying the press is
 * the deterministic harness-level fix; assertions below use set/count
 * semantics so extra presses can't break them.
 */
async function pressUntilInvoked(
  child: { write(data: string): void },
  keys: string,
  marker: string,
  base: number,
): Promise<string[]> {
  const deadline = Date.now() + 15_000
  let lines: string[] = []
  while (Date.now() < deadline) {
    child.write(keys)
    await new Promise((resolve) => setTimeout(resolve, 500))
    lines = await readInvocations(marker)
    if (lines.length > base) return lines
  }
  return lines
}

describe.skipIf(!nodePty)("Pure TUI open-worktree keys (behavior)", () => {
  let env: BehaviorEnv
  let repo: string
  let marker: string

  beforeAll(async () => {
    env = await makeBehaviorEnv()
    repo = await makeScratchRepo(env)
    marker = join(env.home, "editor-opens.log")
    const stateDir = join(env.home, ".config", "kobe")
    await mkdir(stateDir, { recursive: true })
    await writeFile(join(stateDir, "state.json"), JSON.stringify({ onboarded: true }))
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
      // Wait for the task list to actually hydrate (the scratch repo's row),
      // not just the PROJECTS header — the `o` handler needs a selection.
      const deadline = Date.now() + 30_000
      while (!(raw.includes("PROJECTS") && raw.includes("scratch-repo")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(raw).toContain("PROJECTS")

      const direct = await pressUntilInvoked(child, "o", marker, 0)
      expect(direct.length).toBeGreaterThan(0)
      expect(new Set(direct)).toEqual(new Set([repo]))

      const prefixed = await pressUntilInvoked(child, "\x01o", marker, direct.length)
      expect(prefixed.length).toBeGreaterThan(direct.length)
      expect(new Set(prefixed)).toEqual(new Set([repo]))
    } finally {
      data.dispose()
      child.kill()
    }
  }, 45_000)
})
