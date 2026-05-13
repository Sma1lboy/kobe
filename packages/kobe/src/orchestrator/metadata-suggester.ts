/**
 * Single class that wraps every "ask claude for a piece of task
 * metadata" call kobe makes. Today: branch slugs (shipped) +
 * worktree slugs and titles (API only — not yet wired into the
 * orchestrator's main flow).
 *
 * Why a class instead of N exported functions:
 *
 *   - **One init seam.** `findClaudeBinary` is run once per instance,
 *     lazily on first method call, and the resolved path (or `null`
 *     for "binary missing, give up") is cached. Startup is not
 *     blocked: an instance can be constructed eagerly and the probe
 *     fires only when the orchestrator first asks for a suggestion.
 *
 *   - **One spawn + sanitize seam.** Each suggestion is a
 *     timeout-bounded `claude -p` shell-out that resolves to either
 *     a sanitized string or `null`. The instruction text and
 *     sanitizer differ per metadata kind; the runner doesn't.
 *
 *   - **Injectable.** `Orchestrator` accepts a `metadataSuggester` in
 *     its deps. Tests pass a fake that returns canned values without
 *     touching the network or the user's `claude` install.
 *
 * Failure mode contract (matches the previous standalone helper):
 * NEVER throw, NEVER block the user-visible flow. Anything that goes
 * wrong (binary missing, prompt empty, timeout, claude error,
 * unparseable response) collapses to `null`. Callers ALWAYS have a
 * deterministic fallback (deriveTitleFromPrompt for titles, ulid
 * suffix for branches) so a `null` is never a hard failure for the
 * user.
 *
 * TODO(stabilize): each `claude -p` invocation writes a JSONL
 * session under `~/.claude/projects/<cwd-encoded>/<uuid>.jsonl`, so
 * we leak one tiny session per suggestion. To clean those up we'd
 * need to switch this helper to `--output-format stream-json`,
 * capture the session id from the `system.init` event, then call
 * `engine.deleteHistory(sid)` after the rename completes. Tracked
 * outside this consolidation.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { findClaudeBinary } from "../engine/claude-code-local/binary.ts"

/** How long we wait for claude to reply before giving up on a suggestion. */
const SUGGESTION_TIMEOUT_MS = 30_000

/** Hard cap on slug length so kebab outputs stay readable in `git log` and on disk. */
const MAX_SLUG_LEN = 32

/** Hard cap on title length. Wider than the truncate-fallback's 40 since claude tends to be terser. */
const MAX_TITLE_LEN = 60

/**
 * Builder for the prompt fed to `claude -p`. Returns the full
 * instruction text including the user's task at the bottom.
 */
type InstructionBuilder = (userPrompt: string) => string

/**
 * Sanitizer for claude's raw stdout. Returns the cleaned value or
 * `null` if the response was unusable (empty, all-whitespace,
 * sanitization stripped to nothing).
 */
type ResponseSanitizer = (rawStdout: string) => string | null

/**
 * Wraps the `claude -p` one-shot calls used to derive task metadata.
 * One instance per process is the common pattern; the orchestrator
 * holds a default instance unless tests inject their own.
 */
export class MetadataSuggester {
  // null sentinel inside the cached promise = "probed, claude is missing".
  // The promise itself is created lazily so construction is free.
  private binaryPromise: Promise<string | null> | null = null

  /**
   * Suggest a kebab-case slug for a git branch name. The caller composes
   * the final branch (e.g. `kobe/<slug>-<ulid-suffix>`); we only
   * return the action-oriented body.
   */
  async suggestBranchSlug(prompt: string): Promise<string | null> {
    return this.runOneShot(buildBranchInstruction, sanitizeKebabSlug, prompt)
  }

  /**
   * Suggest a kebab-case slug for a per-task git worktree directory.
   * Currently the worktree manager keys on ulid; this method exists
   * for the follow-up that swaps the directory layout. Wiring is
   * deliberately deferred — the API is exposed so the orchestrator
   * can adopt it without another refactor.
   */
  async suggestWorktreeSlug(prompt: string): Promise<string | null> {
    return this.runOneShot(buildWorktreeInstruction, sanitizeKebabSlug, prompt)
  }

  /**
   * Suggest a sentence-case sidebar title. The orchestrator currently
   * uses {@link deriveTitleFromPrompt} (synchronous truncate) on the
   * first prompt; this method exists so a follow-up can promote the
   * derived title to a claude-asked one without touching the call
   * site again.
   */
  async suggestTitle(prompt: string): Promise<string | null> {
    return this.runOneShot(buildTitleInstruction, sanitizeTitleText, prompt)
  }

  /**
   * Resolve the path to the user's `claude` binary, lazily and once.
   * Cached even on failure so we don't repeatedly retry a missing
   * install per-suggestion.
   */
  private async resolveBinary(): Promise<string | null> {
    if (!this.binaryPromise) {
      this.binaryPromise = findClaudeBinary().catch(() => null)
    }
    return this.binaryPromise
  }

  /**
   * Spawn `claude -p <instruction>`, capture stdout to EOF, sanitize.
   * Resolves with the sanitized string or null on any failure path.
   * The promise NEVER rejects — that's a load-bearing invariant for
   * the orchestrator's "fire-and-forget" use of these methods.
   */
  private async runOneShot(
    builder: InstructionBuilder,
    sanitize: ResponseSanitizer,
    prompt: string,
  ): Promise<string | null> {
    const trimmed = prompt.trim()
    if (!trimmed) return null
    const binary = await this.resolveBinary()
    if (!binary) return null

    return new Promise<string | null>((resolve) => {
      let proc: ChildProcess
      try {
        proc = spawn(binary, ["-p", builder(trimmed)], {
          // Don't run inside any worktree — these are tiny string
          // tasks, not project work, and we don't want claude to
          // pull in repo context (or have its cwd matter at all).
          stdio: ["ignore", "pipe", "ignore"],
          env: process.env,
        })
      } catch {
        resolve(null)
        return
      }

      let buf = ""
      let settled = false
      const settle = (v: string | null): void => {
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
        settle(sanitize(buf))
      })
    })
  }
}

/**
 * Deterministic adapter for test/dev paths that must not shell out to
 * the user's real `claude` binary. Keeps the metadata seam explicit:
 * callers still exercise the "suggestion absent" fallback behaviour.
 */
export class NullMetadataSuggester extends MetadataSuggester {
  override async suggestBranchSlug(_prompt: string): Promise<string | null> {
    return null
  }

  override async suggestWorktreeSlug(_prompt: string): Promise<string | null> {
    return null
  }

  override async suggestTitle(_prompt: string): Promise<string | null> {
    return null
  }
}

/* ----------------------------------------------------------------- */
/*  Instruction builders                                              */
/* ----------------------------------------------------------------- */

// All three builders inline their rules into the prompt rather than
// using `--system-prompt` because the latter requires a stable claude
// CLI flag we don't want to depend on. The "Reply with ONLY ..." line
// is load-bearing — without it haiku tends to add a leading "Sure!".

function buildBranchInstruction(prompt: string): string {
  return [
    "Generate a short git branch slug for this user task.",
    "Rules:",
    "- Lowercase, kebab-case, alphanumeric + hyphens only.",
    `- Max ${MAX_SLUG_LEN} characters.`,
    "- Action-oriented (e.g. fix-login-redirect, add-csv-export).",
    "- Reply with ONLY the slug, no other text, no quotes, no explanation.",
    "",
    `User task: ${prompt}`,
    "",
    "Branch slug:",
  ].join("\n")
}

function buildWorktreeInstruction(prompt: string): string {
  return [
    "Generate a short directory-name slug for a per-task git worktree.",
    "Rules:",
    "- Lowercase, kebab-case, alphanumeric + hyphens only.",
    `- Max ${MAX_SLUG_LEN} characters.`,
    "- Topic-oriented; describe the work area, not the action verb.",
    "- Reply with ONLY the slug, no other text, no quotes, no explanation.",
    "",
    `User task: ${prompt}`,
    "",
    "Worktree slug:",
  ].join("\n")
}

function buildTitleInstruction(prompt: string): string {
  return [
    "Generate a short sidebar title for this user task.",
    "Rules:",
    `- ≤ ${MAX_TITLE_LEN} characters, single line.`,
    "- Sentence case, no trailing period.",
    `- Capture the essential action (e.g. "Fix login redirect", "Add CSV export to settings").`,
    `- Reply with ONLY the title, no quotes, no explanation, no leading "Title:".`,
    "",
    `User task: ${prompt}`,
    "",
    "Title:",
  ].join("\n")
}

/* ----------------------------------------------------------------- */
/*  Response sanitizers                                               */
/* ----------------------------------------------------------------- */

/**
 * Strict kebab slug normalizer. Strips anything claude might smuggle
 * in (markdown fences, leading "Branch:" / "Slug:" / "Worktree:",
 * trailing periods) and clamps to MAX_SLUG_LEN. Returns null on
 * empty result so callers don't accidentally produce
 * `kobe/-<ulid>` / `<dir>/-<ulid>`.
 */
function sanitizeKebabSlug(raw: string): string | null {
  const firstLine = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0)
  if (!firstLine) return null

  const cleaned = firstLine
    .toLowerCase()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(branch|slug|worktree)[:\s-]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "")

  return cleaned.length > 0 ? cleaned : null
}

/**
 * Title normalizer — preserves casing and spacing. Strips quote
 * marks, leading "Title:", trailing punctuation runs, then clamps to
 * MAX_TITLE_LEN.
 */
function sanitizeTitleText(raw: string): string | null {
  const firstLine = raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0)
  if (!firstLine) return null

  const cleaned = firstLine
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^title[:\s-]+/i, "")
    .replace(/[\s.!]+$/g, "")
    .slice(0, MAX_TITLE_LEN)
    .trim()

  return cleaned.length > 0 ? cleaned : null
}
