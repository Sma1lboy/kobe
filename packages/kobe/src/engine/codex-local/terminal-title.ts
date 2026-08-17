/**
 * Codex's native OSC 0/2 terminal-title policy (its `terminalTitle`
 * registry block, extracted for the registry's ~500-line cap).
 *
 * Codex's default is activity + project-name, which makes every tab in
 * one repo say "kobe". Keep its native activity state, but ask Codex to
 * pair it with the thread title it already owns in its local store.
 */

import { basename } from "node:path"
import type { EngineRegistryEntry, EngineTitleContext } from "../registry.ts"

/** A codex thread id as written into the OSC title (full UUID). */
const THREAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The running session's id from codex's OSC title: an UNNAMED thread's
 * `thread-title` segment IS the thread UUID (threads get real names only
 * via `/rename`). Lets kobe follow a session switch (the resume picker, a
 * re-run) without a launch-time pin. Naming-only — never used as a spawn
 * pin, codex can't take `--session-id`.
 */
export function codexSessionIdFromTitle(title: string): string | null {
  const trimmed = title.trim()
  return THREAD_ID_RE.test(trimmed) ? trimmed : null
}

/**
 * Placeholder judgement: a title that is just the session id (above) is an
 * identifier, not a name — kobe treats it as "no title" so the naming
 * precedence falls through to the first-prompt auto-title.
 *
 * Second placeholder shape: a codex KOBE DIDN'T LAUNCH (the user closed
 * the engine and re-ran bare `codex` in the tab's shell, resume or not)
 * gets no `-c tui.terminal_title=...` override, so codex's DEFAULT config
 * (activity + project-name) titles it after the project directory — the
 * worktree basename is again a label, not a conversation name. Needs the
 * worktree from ctx; without it the judgement stays shape-only.
 */
export function isCodexPlaceholderTitle(title: string, ctx: EngineTitleContext = {}): boolean {
  const trimmed = title.trim()
  if (THREAD_ID_RE.test(trimmed)) return true
  if (ctx.worktree && trimmed === basename(ctx.worktree)) return true
  return false
}

export const codexTerminalTitle: NonNullable<EngineRegistryEntry["terminalTitle"]> = {
  ownsStatus: true,
  launchArgs: ["-c", 'tui.terminal_title=["activity","thread-title"]'],
  // The `activity` segment is a braille spinner frame joined to the next
  // segment by a space (codex `TERMINAL_TITLE_SPINNER_FRAMES` +
  // `separator_from_previous`). It only appears while a turn runs, so a
  // resting title has no prefix to strip — every status prefix is a
  // working prefix.
  statusPrefixes: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  workingPrefixes: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  isPlaceholderTitle: isCodexPlaceholderTitle,
  sessionIdFromTitle: codexSessionIdFromTitle,
}
