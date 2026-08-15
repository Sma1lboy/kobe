/**
 * Vendor worktree pre-trust (issue #28): each adapter writes its vendor's
 * first-run trust record for a Rove-created worktree — merge-preserving and
 * idempotent, because these stores belong to the user's real CLI installs.
 * Runs against temp HOME dirs; the real stores are never touched.
 */

import { createHash } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { trustClaudeWorktree } from "../../src/engine/claude-code-local/trust.ts"
import { trustCodexWorktree } from "../../src/engine/codex-local/trust.ts"
import { kimiTrustFilePath, trustKimiWorktree } from "../../src/engine/kimi-local/trust.ts"

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-trust-"))
  tempDirs.push(home)
  return home
}

const WORKTREE = "/wt/rove-task-1"

describe("trustKimiWorktree", () => {
  it("writes the workspace-trust record named by sha256(path)[:12]", () => {
    const home = tempHome()
    trustKimiWorktree(WORKTREE, home)
    const hash = createHash("sha256").update(WORKTREE).digest("hex").slice(0, 12)
    const file = kimiTrustFilePath(WORKTREE, home)
    expect(file).toBe(path.join(home, ".kimi-code", "workspace-trust", `wd_rove-task-1_${hash}`))
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as { root: string; trustedAt: number }
    expect(record.root).toBe(WORKTREE)
    expect(typeof record.trustedAt).toBe("number")
  })

  it("is idempotent — an existing record is not rewritten", () => {
    const home = tempHome()
    trustKimiWorktree(WORKTREE, home)
    const file = kimiTrustFilePath(WORKTREE, home)
    fs.writeFileSync(file, JSON.stringify({ root: WORKTREE, trustedAt: 1 }))
    trustKimiWorktree(WORKTREE, home)
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ root: WORKTREE, trustedAt: 1 })
  })
})

describe("trustClaudeWorktree", () => {
  it("merges into an existing store, preserving other projects and keys", () => {
    const home = tempHome()
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        numStartups: 42,
        projects: {
          "/repo": { allowedTools: ["Bash(git *)"], hasTrustDialogAccepted: true },
          [WORKTREE]: { allowedTools: ["Read"] },
        },
      }),
    )
    trustClaudeWorktree(WORKTREE, home)
    const doc = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"))
    expect(doc.numStartups).toBe(42)
    expect(doc.projects["/repo"]).toEqual({ allowedTools: ["Bash(git *)"], hasTrustDialogAccepted: true })
    // The worktree's existing per-project state survives the trust merge.
    expect(doc.projects[WORKTREE]).toMatchObject({
      allowedTools: ["Read"],
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
    })
  })

  it("creates a fresh store when none exists, and skips a second accept", () => {
    const home = tempHome()
    trustClaudeWorktree(WORKTREE, home)
    const file = path.join(home, ".claude.json")
    expect(JSON.parse(fs.readFileSync(file, "utf8")).projects[WORKTREE].hasTrustDialogAccepted).toBe(true)
    const before = fs.readFileSync(file, "utf8")
    trustClaudeWorktree(WORKTREE, home)
    expect(fs.readFileSync(file, "utf8")).toBe(before)
  })
})

describe("trustCodexWorktree", () => {
  it("appends a trusted project table without touching existing config", () => {
    const home = tempHome()
    const dir = path.join(home, ".codex")
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, "config.toml")
    fs.writeFileSync(file, 'model = "gpt-5"\n\n[projects."/repo"]\ntrust_level = "trusted"\n')
    trustCodexWorktree(WORKTREE, home)
    const text = fs.readFileSync(file, "utf8")
    expect(text).toContain('model = "gpt-5"')
    expect(text).toContain(`[projects.${JSON.stringify(WORKTREE)}]\ntrust_level = "trusted"`)
  })

  it("creates the config when absent and never double-appends", () => {
    const home = tempHome()
    trustCodexWorktree(WORKTREE, home)
    trustCodexWorktree(WORKTREE, home)
    const text = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8")
    expect(text.split(`[projects.${JSON.stringify(WORKTREE)}]`)).toHaveLength(2)
  })
})
