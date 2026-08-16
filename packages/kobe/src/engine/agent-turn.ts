/**
 * `AgentTurn` — the engine-owned per-turn attribution record (issue #32).
 *
 * One record per completed agent turn: which model ran, how long it took,
 * what it cost in tokens. The engine adapter is the ONLY thing that knows
 * how to produce one, because the facts live in the vendor's own transcript
 * (claude's JSONL `message.model` + `message.usage`, codex's rollout, …).
 * Neutral layers (daemon, TUI, web) store and render this shape and never
 * parse a vendor file themselves — CLAUDE.md "Engine-owned UI data".
 *
 * `taskId` / `tabId` are deliberately NOT here: a turn is a fact about an
 * engine session, and the engine has no idea what a Rove task is. The daemon
 * joins the two when it records the turn (`agent-turns-store.ts`).
 *
 * Pure data + a pure reader contract; the reader is exposed on the engine
 * registry entry as `readTurns`, so adding a vendor is one adapter file.
 */

import type { EngineUsageSnapshot } from "@/types/engine"

export interface AgentTurn {
  /**
   * Vendor-stable identity for this turn, used to dedupe repeated reads of
   * the same transcript (the hook fires on every Stop, and a transcript is
   * re-read from the top each time). Claude uses the turn's last assistant
   * `message.id`; another vendor may use whatever it persists — the only
   * contract is that the SAME turn yields the SAME id across reads.
   */
  readonly id: string
  /** The engine session this turn belongs to (claude's `sessionId`). */
  readonly sessionId: string
  /** Model that ran the turn, as the vendor names it; absent when unrecorded. */
  readonly model?: string
  /** Turn start (epoch ms) — when the user's prompt entered the transcript. */
  readonly startedAt: number
  /** Turn end (epoch ms) — the last assistant record of the turn. */
  readonly endedAt: number
  /** Token usage for the turn, summed across its assistant messages. */
  readonly usage?: EngineUsageSnapshot
}

/**
 * Read completed turns out of ONE session transcript, oldest-first.
 *
 * `transcriptPath` is the file the engine's own hook reported (claude pipes
 * `transcript_path` on every hook payload), so no worktree scan is needed.
 * Best-effort by contract: a missing, oversize, or unparseable file yields
 * `[]` rather than throwing — telemetry must never break the hook path.
 */
export type EngineTurnReader = (transcriptPath: string) => Promise<readonly AgentTurn[]>
