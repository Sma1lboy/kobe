/**
 * Kimi Code workspace trust (issue #28 / #25 follow-up). Kimi shows a
 * "Trust this folder?" dialog on first launch in a directory — and its
 * default cursor sits on "Don't trust", so a pasted first message's submit
 * Enter EXITS the engine ("Bye!"). The store is one file per workspace:
 * `~/.kimi-code/workspace-trust/wd_<dirname>_<sha256(abspath)[:12]>`
 * containing {"root": <abspath>, "trustedAt": <ms epoch>} (naming verified
 * against live installs 2026-08-15). Pre-trusting a Rove-created worktree
 * is the same trust domain as the repo the user already runs sessions in.
 */

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export function kimiTrustFilePath(worktreePath: string, home: string = homedir()): string {
  const hash = createHash("sha256").update(worktreePath).digest("hex").slice(0, 12)
  return path.join(home, ".kimi-code", "workspace-trust", `wd_${path.basename(worktreePath)}_${hash}`)
}

export function trustKimiWorktree(worktreePath: string, home: string = homedir()): void {
  const file = kimiTrustFilePath(worktreePath, home)
  if (existsSync(file)) return
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ root: worktreePath, trustedAt: Date.now() }), { mode: 0o600 })
}
