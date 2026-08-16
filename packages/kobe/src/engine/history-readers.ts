/**
 * The per-vendor {@link EngineHistoryReader} implementations, split out of
 * `registry.ts` (file-size cap). Each is a thin adapter over its vendor's
 * `*-local/history.ts` module, normalizing store quirks to the registry's
 * contract — nothing else in the tree should import these directly; go
 * through `engineEntry(vendor).history`.
 *
 * Must stay importable from vitest and MUST NOT import from `src/tui/`.
 */

import path from "node:path"
import * as claudeHistory from "./claude-code-local/history.ts"
import * as codexHistory from "./codex-local/history.ts"
import * as copilotHistory from "./copilot-local/history.ts"
import type { EngineHistoryReader } from "./history-reader.ts"
import * as kimiHistory from "./kimi-local/history.ts"

/**
 * The documented empty history reader for engines with no on-disk
 * transcript store (custom engines). Auto-title then keeps the placeholder
 * title rather than mis-reading claude's transcripts (the old
 * `else → claude` default would do exactly that for any unknown id).
 */
export const EMPTY_HISTORY: EngineHistoryReader = {
  async listSessionIdsForWorktree() {
    return []
  },
  async readHistory() {
    return []
  },
  async transcriptPath() {
    return null
  },
  // No transcript store → no activity signal (the Ops badge stays dark
  // rather than mis-watching another vendor's files).
  async latestTranscriptMtimeForWorktree() {
    return 0
  },
}

/**
 * Claude's reader. `listSessionFilesForWorktree` sorts NEWEST-first (the
 * activity callers want that); the registry contract is oldest-first,
 * so re-sort ascending by mtime here — exactly what auto-title did inline.
 */
export const claudeHistoryReader: EngineHistoryReader = {
  async listSessionIdsForWorktree(worktree) {
    const files = await claudeHistory.listSessionFilesForWorktree(worktree)
    return [...files].sort((a, b) => a.mtimeMs - b.mtimeMs).map((f) => f.sessionId)
  },
  readHistory: (sessionId) => claudeHistory.readHistory(sessionId),
  async transcriptPath(sessionId, worktree) {
    const files = await claudeHistory.listSessionFilesForWorktree(worktree)
    return files.find((f) => f.sessionId === sessionId)?.path ?? null
  },
  latestTranscriptMtimeForWorktree: (worktree) => claudeHistory.latestTranscriptMtimeForWorktree(worktree),
}

/** Codex's reader — `listSessionIdsForWorktree` is already oldest-first. */
export const codexHistoryReader: EngineHistoryReader = {
  listSessionIdsForWorktree: (worktree) => codexHistory.listSessionIdsForWorktree(worktree),
  readHistory: (sessionId) => codexHistory.readHistory(sessionId),
  // The rollout filename embeds the UUID; the store is date-keyed, not
  // worktree-keyed, so the worktree argument is unused here.
  transcriptPath: async (sessionId) => (await codexHistory.findRolloutFile(sessionId)) ?? null,
  latestTranscriptMtimeForWorktree: (worktree) => codexHistory.latestTranscriptMtimeForWorktree(worktree),
}

export const copilotHistoryReader: EngineHistoryReader = {
  listSessionIdsForWorktree: (worktree) => copilotHistory.listSessionIdsForWorktree(worktree),
  readHistory: (sessionId) => copilotHistory.readHistory(sessionId),
  // Each session is a dir holding the `events.jsonl` this reader already
  // parses — so the handoff has a file to name (the earlier "not mapped to
  // a per-session file" note predated `findSessionDir`).
  async transcriptPath(sessionId) {
    const dir = await copilotHistory.findSessionDir(sessionId)
    return dir ? path.join(dir, "events.jsonl") : null
  },
  latestTranscriptMtimeForWorktree: (worktree) => copilotHistory.latestTranscriptMtimeForWorktree(worktree),
}

/**
 * Kimi's reader — PATHS ONLY. Its `wire.jsonl` is a protocol stream whose
 * message shape Rove hasn't verified, so `readHistory` stays the empty
 * one (auto-title keeps the placeholder rather than mis-parsing) while
 * the handoff still gets a real file to hand the next agent. That split is
 * exactly why the handoff passes a path instead of converting transcripts.
 */
export const kimiHistoryReader: EngineHistoryReader = {
  listSessionIdsForWorktree: (worktree) => kimiHistory.listSessionIdsForWorktree(worktree),
  // Shares EMPTY_HISTORY's function so `supportsStructuredHistory` reports
  // kimi honestly as "no message reader".
  readHistory: EMPTY_HISTORY.readHistory,
  transcriptPath: (sessionId) => kimiHistory.transcriptPath(sessionId),
  // Activity = newest stream mtime, which the id walk already stats.
  async latestTranscriptMtimeForWorktree(worktree) {
    const ids = await kimiHistory.listSessionIdsForWorktree(worktree)
    const newest = ids.at(-1)
    if (!newest) return 0
    const file = await kimiHistory.transcriptPath(newest)
    return file ? await kimiHistory.transcriptMtime(file) : 0
  },
}
