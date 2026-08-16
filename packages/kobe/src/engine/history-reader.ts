import type { Message } from "@/types/engine"

/**
 * Vendor-neutral reader over one engine's on-disk transcript store.
 * Native paths and formats stay behind the adapter; auto-title, handoff,
 * activity polling, and history rendering consume this contract only.
 */
export interface EngineHistoryReader {
  /**
   * Session ids for `worktree`, oldest first so the task's origin
   * conversation wins auto-naming. Empty when none exist; never throws.
   */
  listSessionIdsForWorktree(worktree: string): Promise<readonly string[]>
  /** Neutral messages for one session id; empty when not found. */
  readHistory(sessionId: string): Promise<Message[]>
  /**
   * Native transcript path, or null when the engine has none to expose.
   * Cross-engine handoff gives this path to the next agent; neutral code
   * must use `readHistory` instead of parsing the file itself.
   */
  transcriptPath(sessionId: string, worktree: string): Promise<string | null>
  /**
   * Newest transcript mtime for `worktree`, or zero when none exists.
   * Best-effort and non-throwing because the activity poll treats zero as
   * "no activity seen".
   */
  latestTranscriptMtimeForWorktree(worktree: string): Promise<number>
}
