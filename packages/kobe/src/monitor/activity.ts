/**
 * Engine-conversation activity probe for the Ops pane (KOB-254).
 *
 * v0.6 hands the interactive surface to tmux, so the monitor has no chat
 * stream to learn "the agent finished a turn" from — and parsing the
 * tmux pane is explicitly off the table (fragile, racy). Instead we read
 * the engine's OWN transcript store, the same on-disk JSONL the cost
 * dashboard and auto-title already use, and watch its mtime: when the
 * newest transcript for a worktree advances, the agent wrote new
 * conversation output. The Ops pane (`kobe ops`) polls this per task and
 * lights a corner badge.
 *
 * Each engine owns "where its transcripts live + which one is newest"
 * (`latestTranscriptMtimeForWorktree`); this module is only the
 * vendor→reader dispatch, mirroring `monitor/auto-title.ts`.
 */

import * as claudeHistory from "@/engine/claude-code-local/history"
import * as codexHistory from "@/engine/codex-local/history"
import * as copilotHistory from "@/engine/copilot-local/history"
import type { VendorId } from "@/types/task"

/**
 * Newest engine-transcript mtime (epoch ms) for `worktree` under
 * `vendor`, or 0 when the task has no transcript yet. Never throws — the
 * per-engine readers are best-effort and the poller treats 0 as "no
 * activity seen".
 */
export async function latestTranscriptMtime(vendor: VendorId, worktree: string): Promise<number> {
  if (!worktree) return 0
  switch (vendor) {
    case "codex":
      return codexHistory.latestTranscriptMtimeForWorktree(worktree)
    case "copilot":
      return copilotHistory.latestTranscriptMtimeForWorktree(worktree)
    case "claude":
      return claudeHistory.latestTranscriptMtimeForWorktree(worktree)
    default:
      // Custom (user-added) engine: no transcript store → no activity badge.
      // Must NOT fall through to claude, which would read another engine's store.
      return 0
  }
}
