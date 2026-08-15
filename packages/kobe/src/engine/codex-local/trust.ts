/**
 * Codex workspace trust (issue #28). Codex gates a never-seen directory
 * behind its own trust prompt; the store is `~/.codex/config.toml` —
 * `[projects."<abspath>"] trust_level = "trusted"`. Pre-trusting a
 * Rove-created worktree is the same trust domain as the repo the user
 * already runs sessions in, and the only headless-viable answer.
 *
 * Append-only: a `[projects.*]` table at EOF attaches to nothing, so the
 * rest of the user's config is never parsed or rewritten.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export function trustCodexWorktree(worktreePath: string, home: string = homedir()): void {
  const dir = path.join(home, ".codex")
  const file = path.join(dir, "config.toml")
  // JSON.stringify doubles as a TOML basic-string quoter for the path.
  const header = `[projects.${JSON.stringify(worktreePath)}]`
  let text = ""
  try {
    text = readFileSync(file, "utf8")
  } catch {
    // No config yet — the append below creates it.
  }
  if (text.includes(header)) return
  mkdirSync(dir, { recursive: true })
  if (!existsSync(file)) writeFileSync(file, "")
  const lead = text.length > 0 && !text.endsWith("\n") ? "\n" : ""
  appendFileSync(file, `${lead}\n${header}\ntrust_level = "trusted"\n`)
}
