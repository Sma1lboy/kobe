/**
 * Lazy branch-name suggestion via a one-shot `claude -p` call.
 *
 * Why this exists: kobe's lazy worktree allocator (see core.ts
 * `ensureWorktree`) creates the branch with a temp name like
 * `kobe/tmp-<ulid>` so the engine can start streaming immediately.
 * Once the user's first prompt is in flight we fire off a small
 * background claude call asking for a clean kebab slug, then rename
 * the branch in place via `git branch -m`. This keeps the chat
 * latency low AND gives the user a meaningful branch name without
 * forcing them to think about it.
 *
 * Failure modes are silent — we never block the chat or surface
 * naming errors. If claude can't be located, the prompt times out,
 * or the response is malformed, the temp name stays (the user can
 * always rename later via `r` in the sidebar).
 *
 * TODO(stabilize): each `claude -p` invocation writes a JSONL
 * session under `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`, so
 * we leak one tiny session per branch suggestion. To clean those up
 * we'd need to switch this helper to `--output-format stream-json`,
 * capture the session id from the `system.init` event, then call
 * `engine.deleteHistory(sid)` after the rename completes. Deferring
 * until the lazy-worktree flow is stable end-to-end.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { findClaudeBinary } from "../engine/claude-code-local/binary.ts"

/** How long we wait for claude to reply before giving up. */
const SUGGESTION_TIMEOUT_MS = 30_000

/** Hard cap on the slug length so it stays readable in `git log`. */
const MAX_SLUG_LEN = 32

/**
 * Ask claude (`-p`, one-shot) for a kebab-case slug for `prompt`.
 *
 * Returns a slug *without* the `kobe/` prefix or the ulid suffix —
 * the caller composes the final branch name. Returns null on any
 * failure (binary missing, prompt empty, claude error, malformed
 * response, timeout).
 *
 * The wrapped instructions live in the prompt itself rather than
 * `--system-prompt` because the latter requires a stable claude CLI
 * flag — sticking to `-p <text>` keeps us compatible with older
 * binaries the user might have installed.
 */
export async function suggestBranchSlug(prompt: string): Promise<string | null> {
  const trimmed = prompt.trim()
  if (!trimmed) return null

  let binary: string
  try {
    binary = await findClaudeBinary()
  } catch {
    return null
  }

  // The instruction block is intentionally terse so claude doesn't
  // get creative with explanations or markdown. The "ONLY the slug"
  // line is load-bearing — without it haiku tends to add a leading
  // "Sure, here's the slug:".
  const instruction = [
    "Generate a short git branch slug for this user task.",
    "Rules:",
    "- Lowercase, kebab-case, alphanumeric + hyphens only.",
    `- Max ${MAX_SLUG_LEN} characters.`,
    "- Action-oriented (e.g. fix-login-redirect, add-csv-export).",
    "- Reply with ONLY the slug, no other text, no quotes, no explanation.",
    "",
    `User task: ${trimmed}`,
    "",
    "Branch slug:",
  ].join("\n")

  return new Promise<string | null>((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(binary, ["-p", instruction], {
        // Don't run in any of the worktrees — we don't want claude to
        // pull in repo context for what is essentially a tiny string
        // task. Default cwd (kobe's binary cwd) is fine.
        stdio: ["ignore", "pipe", "ignore"],
        env: process.env,
      })
    } catch {
      resolve(null)
      return
    }

    let buf = ""
    let settled = false
    const settle = (v: string | null) => {
      if (settled) return
      settled = true
      try {
        proc.kill()
      } catch {
        /* already dead */
      }
      resolve(v)
    }

    const timer = setTimeout(() => settle(null), SUGGESTION_TIMEOUT_MS)

    proc.stdout?.on("data", (chunk: Buffer | string) => {
      buf += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    })
    proc.on("error", () => {
      clearTimeout(timer)
      settle(null)
    })
    proc.on("close", () => {
      clearTimeout(timer)
      settle(sanitizeSlug(buf))
    })
  })
}

/**
 * Strict slug normalizer. Strips anything claude might smuggle in
 * (markdown fences, leading "Branch:", trailing periods) and clamps
 * to MAX_SLUG_LEN. Returns null on empty result so the caller
 * doesn't accidentally produce `kobe/-<ulid>`.
 *
 * Exported for unit testing.
 */
export function sanitizeSlug(raw: string): string | null {
  // Take just the first non-empty line — claude sometimes adds a
  // trailing newline + a stray comment.
  const firstLine = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0)
  if (!firstLine) return null

  const cleaned = firstLine
    .toLowerCase()
    // strip surrounding quotes / backticks / leading prefixes
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(branch[:\s-]+|slug[:\s-]+)/, "")
    // anything that isn't [a-z0-9] becomes a hyphen
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "") // post-truncation tidy

  return cleaned.length > 0 ? cleaned : null
}
