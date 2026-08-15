/**
 * Claude Code workspace trust (issue #28). Claude gates a first launch in a
 * never-seen directory behind a "Do you trust the files in this folder?"
 * dialog; a Rove task worktree is always such a directory, so a hosted
 * session would sit at the dialog forever. Rove created the worktree from a
 * repo the user already drives sessions in — pre-accepting trust for it is
 * the same trust domain, and the only headless-viable answer.
 *
 * The store is `~/.claude.json` → `projects[<abspath>].hasTrustDialogAccepted`
 * (existing entries also carry `hasCompletedProjectOnboarding`). MERGE, never
 * clobber: project entries accumulate per-project state (allowedTools, MCP
 * choices) that must survive.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export function trustClaudeWorktree(worktreePath: string, home: string = homedir()): void {
  const file = path.join(home, ".claude.json")
  let doc: Record<string, unknown> = {}
  try {
    doc = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
  } catch {
    // Missing or corrupt — start from an empty doc; corrupt is claude's own
    // recovery behavior too (it rewrites the file wholesale on every save).
  }
  const projects = { ...((doc.projects as Record<string, unknown> | undefined) ?? {}) }
  const existing = (projects[worktreePath] ?? {}) as Record<string, unknown>
  if (existing.hasTrustDialogAccepted === true) return
  projects[worktreePath] = { ...existing, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }
  doc.projects = projects
  // tmp + rename so a crash mid-write can't truncate the store.
  const tmp = `${file}.rove-${process.pid}`
  writeFileSync(tmp, JSON.stringify(doc, null, 2))
  renameSync(tmp, file)
}
