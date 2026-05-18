/**
 * Single class that wraps every "ask the active engine for a piece of
 * task metadata" call kobe makes. Today: branch slugs (shipped) +
 * worktree slugs and titles (API only — not yet wired into the
 * orchestrator's main flow).
 *
 * Why a class instead of N exported functions:
 *
 *   - **One spawn + sanitize seam.** Each suggestion is a
 *     timeout-bounded engine one-shot that resolves to either
 *     a sanitized string or `null`. The instruction text and
 *     sanitizer differ per metadata kind; the runner doesn't.
 *
 *   - **Injectable.** `Orchestrator` accepts a `metadataSuggester` in
 *     its deps. Tests pass a fake that returns canned values without
 *     touching the network or the user's engine install.
 *
 * Failure mode contract (matches the previous standalone helper):
 * NEVER throw, NEVER block the user-visible flow. Anything that goes
 * wrong (engine error, prompt empty, timeout,
 * unparseable response) collapses to `null`. Callers ALWAYS have a
 * deterministic fallback (deriveTitleFromPrompt for titles, ulid
 * suffix for branches) so a `null` is never a hard failure for the
 * user.
 *
 * Metadata sessions are deleted best-effort after the one-shot stream
 * completes so these suggestions do not clutter the user's history.
 */

import type { AIEngine, Message, ModelEffortLevel, PermissionMode, SessionHandle, SpawnOpts } from "../types/engine.ts"

/** How long we wait for the engine to reply before giving up on a suggestion. */
const SUGGESTION_TIMEOUT_MS = 30_000

/** Hard cap on slug length so kebab outputs stay readable in `git log` and on disk. */
const MAX_SLUG_LEN = 32

/** Hard cap on title length. Wider than the truncate-fallback's 40 since claude tends to be terser. */
const MAX_TITLE_LEN = 60

/**
 * How many most-recent messages we hand to the recap one-shot. Mirrors
 * Claude Code's `RECENT_MESSAGE_WINDOW = 30` (~15 turns) — plenty for
 * "where we left off" and well under the small-fast model's context.
 */
const RECAP_MESSAGE_WINDOW = 30

/** Per-message text cap when serializing the transcript into the recap prompt. */
const RECAP_PER_MESSAGE_CHAR_CAP = 1200

/** Hard cap on the recap output length, after sanitization. */
const MAX_RECAP_LEN = 600

/**
 * Builder for the prompt fed to the selected engine. Returns the full
 * instruction text including the user's task at the bottom.
 */
type InstructionBuilder = (userPrompt: string) => string

/**
 * Sanitizer for claude's raw stdout. Returns the cleaned value or
 * `null` if the response was unusable (empty, all-whitespace,
 * sanitization stripped to nothing).
 */
type ResponseSanitizer = (rawStdout: string) => string | null

export type MetadataSuggestionContext = {
  readonly engine: AIEngine
  readonly cwd: string
  readonly model?: string
  readonly modelEffort?: ModelEffortLevel
  readonly permissionMode?: PermissionMode
}

/**
 * Wraps the engine one-shot calls used to derive task metadata.
 * One instance per process is the common pattern; the orchestrator
 * holds a default instance unless tests inject their own.
 */
export class MetadataSuggester {
  /**
   * Suggest a kebab-case slug for a git branch name. The caller composes
   * the final branch (e.g. `kobe/<slug>-<ulid-suffix>`); we only
   * return the action-oriented body.
   */
  async suggestBranchSlug(prompt: string, context: MetadataSuggestionContext): Promise<string | null> {
    return this.runOneShot(buildBranchInstruction, sanitizeKebabSlug, prompt, context)
  }

  /**
   * Suggest a kebab-case slug for a per-task git worktree directory.
   * Currently the worktree manager keys on ulid; this method exists
   * for the follow-up that swaps the directory layout. Wiring is
   * deliberately deferred — the API is exposed so the orchestrator
   * can adopt it without another refactor.
   */
  async suggestWorktreeSlug(prompt: string, context: MetadataSuggestionContext): Promise<string | null> {
    return this.runOneShot(buildWorktreeInstruction, sanitizeKebabSlug, prompt, context)
  }

  /**
   * Suggest a sentence-case sidebar title. The orchestrator currently
   * uses {@link deriveTitleFromPrompt} (synchronous truncate) on the
   * first prompt; this method exists so a follow-up can promote the
   * derived title to a claude-asked one without touching the call
   * site again.
   */
  async suggestTitle(prompt: string, context: MetadataSuggestionContext): Promise<string | null> {
    return this.runOneShot(buildTitleInstruction, sanitizeTitleText, prompt, context)
  }

  /**
   * Suggest a 1-3 sentence "while you were away" recap from a chat
   * transcript. Mirrors Claude Code's
   * `services/awaySummary.ts` — last 30 messages, instruction asks for
   * high-level task + concrete next step, no status reports / commit
   * recaps. Caller picks the small-fast model via
   * `context.model` (typically `engine.capabilities.smallFastModelId()`).
   *
   * Empty / single-row histories collapse to `null` so the recap row
   * is only ever inserted when there's something to recap.
   */
  async suggestRecap(history: readonly Message[], context: MetadataSuggestionContext): Promise<string | null> {
    if (history.length === 0) return null
    const transcript = renderRecapTranscript(history)
    if (!transcript) return null
    return this.runOneShot(() => buildRecapInstruction(transcript), sanitizeRecapText, transcript, context)
  }

  /**
   * Spawn the selected engine with a metadata-only instruction,
   * capture assistant text to EOF, sanitize.
   * Resolves with the sanitized string or null on any failure path.
   * The promise NEVER rejects — that's a load-bearing invariant for
   * the orchestrator's "fire-and-forget" use of these methods.
   */
  private async runOneShot(
    builder: InstructionBuilder,
    sanitize: ResponseSanitizer,
    prompt: string,
    context: MetadataSuggestionContext,
  ): Promise<string | null> {
    const trimmed = prompt.trim()
    if (!trimmed) return null

    let handle: SessionHandle | null = null
    let timedOut = false
    const opts: SpawnOpts = {
      ...(context.model ? { model: context.model } : {}),
      ...(context.modelEffort ? { modelEffort: context.modelEffort } : {}),
      ...(context.permissionMode ? { permissionMode: context.permissionMode } : {}),
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true
        if (handle) void context.engine.stop(handle).catch(() => {})
        resolve(null)
      }, SUGGESTION_TIMEOUT_MS)
    })
    const run = (async (): Promise<string | null> => {
      try {
        handle = await context.engine.spawn(context.cwd, builder(trimmed), opts)
        let buf = ""
        for await (const ev of context.engine.stream(handle)) {
          if (ev.type === "assistant.delta") {
            buf += ev.text
          } else if (ev.type === "error") {
            return null
          }
        }
        return sanitize(buf)
      } catch {
        return null
      } finally {
        if (timer) clearTimeout(timer)
        if (handle) {
          if (!timedOut) {
            await context.engine.deleteHistory(handle.sessionId).catch(() => {})
          }
          if (timedOut) {
            await context.engine.stop(handle).catch(() => {})
          }
        }
      }
    })()
    return await Promise.race([run, timeout])
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

  override async suggestRecap(_history: readonly Message[]): Promise<string | null> {
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
    "Generate a short feature-style task name from this conversation.",
    "Rules:",
    `- ≤ ${MAX_TITLE_LEN} characters, single line.`,
    "- Sentence case, no trailing period, no ticket prefix.",
    "- Name the durable feature or fix, not the latest chat message.",
    `- Prefer noun/action phrases like "Codex title routing" or "Queued prompt editing".`,
    `- Reply with ONLY the title, no quotes, no explanation, no leading "Title:".`,
    "",
    prompt,
    "",
    "Feature name:",
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
 * Serialize the last {@link RECAP_MESSAGE_WINDOW} messages into a
 * `role: text` transcript fragment for the recap prompt. Only `text`
 * blocks make it in — tool calls / results / thinking are too noisy
 * for a 1-3 sentence summary. Per-message text is capped so a single
 * runaway turn can't blow the small-fast model's prompt budget.
 *
 * Returns `null` when no message in the window contributed any text
 * (e.g. a session that only ran tools).
 */
function renderRecapTranscript(history: readonly Message[]): string | null {
  const window = history.slice(-RECAP_MESSAGE_WINDOW)
  const lines: string[] = []
  for (const m of window) {
    let text = ""
    for (const b of m.blocks) {
      if (b.type === "text" && b.text) text += text ? `\n${b.text}` : b.text
    }
    const cleaned = text.trim()
    if (!cleaned) continue
    const capped = cleaned.length > RECAP_PER_MESSAGE_CHAR_CAP ? `${cleaned.slice(0, RECAP_PER_MESSAGE_CHAR_CAP)}…` : cleaned
    lines.push(`${m.role}: ${capped}`)
  }
  if (lines.length === 0) return null
  return lines.join("\n\n")
}

function buildRecapInstruction(transcript: string): string {
  // Mirrors `refs/claude-code/src/services/awaySummary.ts`'s prompt:
  // 1-3 sentences, lead with the high-level task, then concrete next
  // step, NO status reports / commit recaps. "Reply with ONLY the
  // summary" is the same load-bearing line we use elsewhere — without
  // it haiku-class models tend to prefix "Sure!".
  return [
    "The user stepped away and is coming back. Read the conversation transcript below and write a short recap.",
    "Rules:",
    "- Exactly 1-3 short sentences.",
    "- Start by stating the high-level task — what is being built or debugged, not implementation details.",
    "- Then state the concrete next step.",
    "- Skip status reports and commit recaps.",
    "- Reply with ONLY the recap sentences, no preamble, no quotes, no markdown.",
    "",
    "Transcript:",
    transcript,
    "",
    "Recap:",
  ].join("\n")
}

/**
 * Recap text normalizer — strip wrapping quotes and a leading
 * "Recap:"/"Summary:" the model sometimes adds despite the
 * instruction, collapse whitespace, clamp to {@link MAX_RECAP_LEN}.
 * Newlines are preserved (the renderer dim-wraps anyway), but tabs
 * and repeated blank lines are normalized.
 */
function sanitizeRecapText(raw: string): string | null {
  let cleaned = raw
    .replace(/\t+/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  if (!cleaned) return null
  cleaned = cleaned
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(recap|summary)[:\s-]+/i, "")
    .trim()
  if (!cleaned) return null
  if (cleaned.length > MAX_RECAP_LEN) cleaned = `${cleaned.slice(0, MAX_RECAP_LEN).trimEnd()}…`
  return cleaned
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
