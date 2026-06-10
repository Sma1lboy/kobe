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
 * (`EngineHistoryReader.latestTranscriptMtimeForWorktree`); this module
 * is only a thin convenience over the engine registry, kept so the Ops
 * pane's import stays put.
 */

import { engineEntry } from "@/engine/registry"
import type { VendorId } from "@/types/task"

/**
 * Newest engine-transcript mtime (epoch ms) for `worktree` under
 * `vendor`, or 0 when the task has no transcript yet. Never throws — the
 * per-engine readers are best-effort and the poller treats 0 as "no
 * activity seen". A custom (user-added) engine resolves to the registry's
 * EMPTY history reader, which always answers 0 — no transcript store →
 * no activity badge (and never mis-reading another engine's store).
 */
export async function latestTranscriptMtime(vendor: VendorId, worktree: string): Promise<number> {
  if (!worktree) return 0
  return engineEntry(vendor).history.latestTranscriptMtimeForWorktree(worktree)
}
