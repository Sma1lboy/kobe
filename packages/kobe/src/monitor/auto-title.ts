/**
 * Derive a task title from its session transcript.
 *
 * In the v0.6 tmux model kobe never sees the user's prompt directly —
 * the engine runs interactively in a tmux pane — so a task created via
 * the dialog keeps its placeholder title (`(new task)`) until we read
 * it back from the session transcript. We take the FIRST user message
 * of the task's origin session and truncate it via
 * `deriveTitleFromPrompt` (no model call — pure string work, the cheap
 * replacement for the old headless `claude -p` naming path).
 *
 * Engine-aware via the registry: the task's `vendor` resolves an
 * `EngineHistoryReader` (claude-code's per-worktree `~/.claude/projects/*`
 * vs Codex's global `~/.codex/sessions/**` rollouts vs Copilot's
 * session-state dirs), all exposing the same oldest-first session list
 * + `readHistory(sessionId)` returning neutral `Message[]`, so the
 * extraction below stays vendor-neutral. A custom (user-added) engine
 * resolves to the registry's documented EMPTY reader — auto-title then
 * keeps the placeholder title rather than mis-reading claude's
 * transcripts.
 */

import { engineEntry } from "@/engine/registry"
import { deriveTitleFromPrompt } from "@/orchestrator/title"
import type { Message } from "@/types/engine"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"

const MAX_SESSIONS_SCANNED = 8
const MAX_TITLE_INPUT_CHARS = 1000

export interface TaskTitleInput {
  readonly text: string
  readonly fallbackTitle: string
}

function textBlocks(message: Message): string {
  return message.blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join(" ")
}

function copyString(value: string): string {
  return value.length > 0 ? Buffer.from(value, "utf8").toString("utf8") : value
}

function fallbackTitleFromPrompt(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim()
  if (!collapsed) return ""
  // First sentence is usually the task intent; details after it are often
  // reproduction notes or constraints that make poor sidebar labels.
  const firstSentence = /^(.*?[.!?])\s/.exec(collapsed)?.[1] ?? collapsed
  return deriveTitleFromPrompt(firstSentence)
}

/** Title-generation input from messages, or `null` if no user text exists yet. */
function titleInputFromMessages(messages: Message[]): TaskTitleInput | null {
  const firstUser = messages.find((m) => m.role === "user")
  if (!firstUser) return null
  const firstUserText = textBlocks(firstUser)
  const fallbackTitle = fallbackTitleFromPrompt(firstUserText)
  if (!fallbackTitle) return null

  const text = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map(textBlocks)
    .filter(Boolean)
    .join("\n")
  const capped = text.length > MAX_TITLE_INPUT_CHARS ? text.slice(-MAX_TITLE_INPUT_CHARS) : text
  // Force-copy before the title escapes into long-lived state (the task
  // store in the daemon process, via orch.setTitle). `deriveTitleFromPrompt`
  // truncates with `.slice(...)`, and in JSC (Bun) a slice SHARES the parent
  // string's backing buffer — so a 40-char title would otherwise pin the
  // user's entire (possibly pasted-huge) first prompt in memory for the life
  // of the daemon. Buffer round-trip allocates an independent string.
  return { text: copyString(capped), fallbackTitle: copyString(fallbackTitle) }
}

/** First user message's fallback title, or `""` if none yet. */
function titleFromMessages(messages: Message[]): string {
  return titleInputFromMessages(messages)?.fallbackTitle ?? ""
}

/**
 * The truncated first-user-prompt title for the task rooted at
 * `worktree`, or `""` when there's no session / no user message yet
 * (caller leaves the placeholder in place). Never throws on a missing
 * file — returns `""`.
 */
export async function deriveTitleFromSession(
  worktree: string,
  vendor: VendorId = DEFAULT_TASK_VENDOR,
): Promise<string> {
  return (await deriveTitleInputFromSession(worktree, vendor))?.fallbackTitle ?? ""
}

/**
 * Bounded text input + deterministic fallback title for AI task naming.
 * Returns `null` when there is no usable human prompt yet.
 */
export async function deriveTitleInputFromSession(
  worktree: string,
  vendor: VendorId = DEFAULT_TASK_VENDOR,
): Promise<TaskTitleInput | null> {
  if (!worktree) return null
  const { history } = engineEntry(vendor)
  const ids = await history.listSessionIdsForWorktree(worktree)
  // Walk sessions oldest-first (the task's origin conversation comes
  // first) and return the first that yields a usable title. We don't
  // stop at the very earliest session: its opening "user" record can be
  // a non-text block (a tool result, a slash-command echo), which would
  // give an empty title. Capped so a busy worktree doesn't read dozens
  // of transcripts.
  for (const sessionId of ids.slice(0, MAX_SESSIONS_SCANNED)) {
    const input = titleInputFromMessages(await history.readHistory(sessionId))
    if (input) return input
  }
  return null
}

/**
 * The truncated first-user-prompt title for ONE specific engine session,
 * or `""` when that session has no usable user message yet. Used by the
 * per-ChatTab auto-namer, which knows exactly which session id runs in each
 * window (claude `--session-id`); `readHistory` finds the transcript by id
 * across project dirs, so no worktree is needed. Never throws.
 */
export async function deriveTitleFromSessionId(vendor: VendorId, sessionId: string): Promise<string> {
  if (!sessionId) return ""
  try {
    return titleFromMessages(await engineEntry(vendor).history.readHistory(sessionId))
  } catch {
    return ""
  }
}
