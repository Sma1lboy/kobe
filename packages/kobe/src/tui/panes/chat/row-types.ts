/**
 * Type contracts for chat rows + state.
 *
 * Lifted out of `store.ts` so row renderers can `import type` what they
 * need without dragging the live-event reducer's module graph along.
 * Same shapes; this file is purely type-level.
 *
 * The renderers next door (`MessageRows.tsx`, `ToolRow.tsx`,
 * `UserInputRows.tsx`, etc.) consume `ChatRow`; `useChatSession`
 * consumes `ChatState`. Both are also re-exported from `store.ts` for
 * backwards compatibility with the 13+ pre-existing import sites.
 */

import type { SessionUsageMetrics } from "../../../session/usage-metrics.ts"
import type { PendingBashContext } from "./bash-state.ts"
import type { QueuedPrompt } from "./queue.ts"

/** One chronological row in the chat. The renderer maps these to JSX. */
export type ChatRow =
  | { readonly kind: "user"; readonly text: string; readonly ts: string }
  | { readonly kind: "assistant"; readonly text: string; readonly ts: string }
  | { readonly kind: "reasoning"; readonly text: string; readonly ts: string }
  | {
      readonly kind: "tool"
      readonly name: string
      readonly input: unknown
      readonly output?: unknown
      readonly done: boolean
      readonly ts: string
      /**
       * Claude Code's `tool_use_id`. Set by history hydration so a
       * later `tool_result` block can be paired by id (the live event
       * path matches by name only — see `applyEvent`'s `tool.result`
       * case — which is fine in-stream where one call rarely overlaps
       * with another of the same name, but breaks for replay where
       * the full session is on disk and parallel same-name calls are
       * common). Optional: live tool rows leave it undefined.
       */
      readonly toolUseId?: string
    }
  | { readonly kind: "system"; readonly text: string; readonly ts: string }
  /**
   * "The model is paused, the user has to choose something." Synthesized
   * by the orchestrator from a known user-input tool. Two flavours so
   * far — `ExitPlanMode` (binary approve/reject of a plan) and
   * `AskUserQuestion` (1-4 multiple-choice questions). The renderer
   * shows a per-kind interactive widget; the user's submission flows
   * back through `Orchestrator.respondToInput` which flips this row's
   * status (see the `user_input.resolved` handler in `applyEvent`)
   * and resumes the session with a synthesized prompt.
   */
  | {
      readonly kind: "approval"
      readonly requestId: string
      readonly tool: "ExitPlanMode"
      readonly plan: string
      readonly filePath: string | null
      readonly status: "pending" | "approved" | "rejected"
      readonly ts: string
    }
  | {
      readonly kind: "question"
      readonly requestId: string
      readonly questions: ReadonlyArray<{
        readonly question: string
        readonly header: string
        readonly multiSelect: boolean
        readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
      }>
      /** `null` while pending; populated with `questionText → answer` once the user submits. */
      readonly answers: Readonly<Record<string, string>> | null
      readonly ts: string
    }
  /**
   * User-initiated `!shell` command (Claude-Code-style bash mode). Runs
   * locally in the TUI process — not via the engine subprocess — and
   * streams stdout/stderr into the row as it executes. On completion the
   * interaction is appended to {@link ChatState.pendingBashContext} so the
   * next regular prompt prepends `<bash-input>` / `<bash-stdout>` /
   * `<bash-stderr>` XML to give the model the context.
   *
   * Local-only by design (v1): not broadcast over the orchestrator event
   * bus, so other TUIs attached to the same daemon don't see the row.
   * Persistence: the bash row itself doesn't survive a kobe restart
   * (lives in module-scoped ChatState), but its XML context lands in
   * claude-code's JSONL via the subsequent regular prompt, so the model
   * retains visibility across a restart.
   */
  | {
      readonly kind: "bash"
      readonly id: string
      readonly command: string
      readonly stdout: string
      readonly stderr: string
      /** `null` while running. Set on exit (or to a sentinel like -1 on signal). */
      readonly exitCode: number | null
      /** `null` unless the process exited via signal (e.g. "SIGINT" on Ctrl-C). */
      readonly signal: string | null
      readonly done: boolean
      readonly ts: string
    }

export interface ChatState {
  /** All messages in chronological order. Render in array order. */
  readonly messages: readonly ChatRow[]
  /** True between user submit and `done`/`error`. Drives the spinner + cursor. */
  readonly isStreaming: boolean
  /** Transient error banner. Cleared on next submit. */
  readonly error: string | null
  /**
   * Latest Session usage metrics. Hydrated from full Session history when
   * available, then updated from the live engine terminal `result` frame.
   * Drives the WORKSPACE header context meter; cleared when the user starts
   * a new turn so stale %s don't sit above an in-flight request.
   */
  readonly lastUsage?: SessionUsageMetrics
  /**
   * Timestamp for the user turn currently awaiting a terminal usage frame.
   * Used to derive total token speed the same way ccstatusline does:
   * total input+output tokens divided by active user→assistant duration.
   */
  readonly activeTurnStartedAt?: string
  /**
   * Prompts the user typed mid-stream and chose to QUEUE (not steer).
   * FIFO; drained by the chat shell when {@link isStreaming} flips
   * false. Per-tab and **survives task switches + Chat remounts** —
   * the queue lives with the tab via `useChatSession`'s module-scoped
   * `statesByTab` (KOB-61). Not persisted to JSONL or the daemon, so
   * a daemon restart or full TUI quit still drops the queue.
   */
  readonly queue: readonly QueuedPrompt[]
  /**
   * Completed `!shell` interactions waiting to be injected into the
   * next regular user prompt as `<bash-input>` / `<bash-stdout>` /
   * `<bash-stderr>` XML. FIFO; drained on the next non-bash submit.
   * Cleared on `/clear` and tab close. Like {@link queue}, not
   * persisted — but the resulting XML-prefixed prompt IS persisted by
   * the engine, so the model retains the context across restarts.
   */
  readonly pendingBashContext?: readonly PendingBashContext[]
}
