/**
 * kobe chat state — single chronological `messages` array.
 *
 * **Why one array, not three.** The earlier design split state into
 * `past + live + draftUser` (mirroring the engine's "history vs. live
 * events" split). The split couldn't preserve multi-turn user history:
 * `draftUser` was a single slot, so each new user submit overwrote the
 * previous prompt and the user's earlier turns vanished from the chat
 * unless we forced a JSONL re-read on every `done`. opcode's
 * `claude-code-session` does the right thing — one `messages[]` that
 * grows, user submits append to it, assistant deltas append (or
 * coalesce into the in-flight assistant row), tool events append in
 * arrival order. We follow that.
 *
 * Lifecycle:
 *
 *   1. Task mount / sessionId change:
 *        state = createInitialState()
 *        const past = await engine.readHistory(sessionId)
 *        state = setMessagesFromHistory(state, past)
 *   2. Subscribe to orchestrator events.
 *   3. On user submit:
 *        state = pushUser(state, prompt)
 *        await orchestrator.runTask(taskId, prompt)
 *   4. On each EngineEvent:
 *        state = applyEvent(state, ev)
 *   5. On task switch: state for the outgoing task's tabs is left in
 *      place — `statesByTab` is module-scoped in useChatSession, so
 *      returning to a tab brings its queue / messages back without
 *      a fresh `createInitialState()` (KOB-61). Only the event
 *      subscriptions are torn down + re-attached.
 *
 * No re-read on `done`. Live events ARE the canonical record while the
 * session is open; the next mount picks up everything from JSONL.
 *
 * No Solid / opentui imports — pure data, vitest-friendly under Node.
 */

import type { SessionUsageMetrics } from "../../../session/usage-metrics.ts"
import type { EngineEvent, Message, OrchestratorEvent } from "../../../types/engine.ts"

/* --------------------------------------------------------------------- */
/*  Bounded scrollback                                                    */
/* --------------------------------------------------------------------- */

/**
 * Maximum number of {@link ChatRow}s retained per chat tab. When a
 * mutation would push `messages.length` above this cap, the oldest
 * rows are dropped from the front and a single coalescing sentinel
 * `system` row is left at index 0 so the user knows scrollback was
 * truncated.
 *
 * **Why 1000.** The perf baseline (`docs/perf/baseline.md`,
 * "Streaming 1000 assistant.delta events") measured RSS growth of
 * ~168 MB across a 1000-event burst that all coalesce into one row
 * — i.e. the row count cap is not what bounded *that* run; the
 * underlying string is. But a real session that produces 1000
 * distinct rows (alternating user/assistant + tools) sits in the
 * same RSS ballpark, and 1000 rows is well past the point where
 * scrollback ceases to be useful (Claude Code's own scroll buffer
 * is similar). Halve later if the memory profile shifts.
 *
 * Not user-tunable yet — see PLAN.md for the eventual settings hook.
 */
export const SCROLLBACK_CAP = 1000

/** Plain-ASCII sentinel marker. Pattern is grepped to coalesce. */
const SENTINEL_PREFIX = "(scrollback truncated — "
const SENTINEL_SUFFIX = " rows dropped)"

/** Build a sentinel row body for `n` dropped rows. */
function sentinelText(n: number): string {
  return `${SENTINEL_PREFIX}${n}${SENTINEL_SUFFIX}`
}

/**
 * Parse the dropped-count from a sentinel row's text. Returns `null`
 * if the text doesn't match the sentinel shape — used to detect
 * "is this row a previously-emitted sentinel we should coalesce
 * into?" without piggy-backing extra fields on `ChatRow`.
 */
function parseSentinelCount(text: string): number | null {
  if (!text.startsWith(SENTINEL_PREFIX) || !text.endsWith(SENTINEL_SUFFIX)) return null
  const middle = text.slice(SENTINEL_PREFIX.length, text.length - SENTINEL_SUFFIX.length)
  const n = Number.parseInt(middle, 10)
  return Number.isFinite(n) && n >= 0 && String(n) === middle ? n : null
}

/**
 * Return `messages` capped to {@link SCROLLBACK_CAP} rows. If already
 * within cap, the same array is returned (identity-stable for downstream
 * reactivity). When truncation runs:
 *
 *   - Oldest content rows are dropped from the front.
 *   - A single `system` sentinel row is placed at index 0 indicating
 *     how many rows were dropped in total.
 *   - If a sentinel was already at index 0, its count is bumped — we
 *     never end up with two sentinels stacked.
 *
 * The caller is responsible for not invoking this mid-coalesce of a
 * live row; in practice every mutation path here appends to (or
 * patches) the tail, and the live in-flight assistant row is the
 * last element. Front-truncation never touches the tail, so the live
 * row is preserved by construction.
 *
 * Pure: builds a new array only when truncation is needed.
 */
function capMessages(messages: readonly ChatRow[], nowIso: string): readonly ChatRow[] {
  if (messages.length <= SCROLLBACK_CAP) return messages

  const head = messages[0]
  const existingDropped = head && head.kind === "system" ? parseSentinelCount(head.text) : null

  // Slice from `start` to the end keeps the most-recent rows. When
  // there's no existing sentinel we reserve one slot for the new one
  // (cap = sentinel + (cap-1) content rows). When there IS one, we
  // also reserve one slot — and skip the old sentinel itself, so
  // dropped-count reflects only content rows lost over time.
  const reserveSentinel = 1
  const start = messages.length - (SCROLLBACK_CAP - reserveSentinel)
  const tail = messages.slice(Math.max(start, existingDropped !== null ? 1 : 0))

  // How many content rows did we actually drop in this call?
  // - With no prior sentinel: `start` content rows dropped.
  // - With a prior sentinel: rows from index 1..start dropped, i.e.
  //   `start - 1` content rows (we never re-count the sentinel itself).
  const droppedThisCall = existingDropped !== null ? Math.max(0, start - 1) : Math.max(0, start)
  const totalDropped = (existingDropped ?? 0) + droppedThisCall

  const sentinelTs = existingDropped !== null && head ? head.ts : nowIso
  const sentinel: ChatRow = { kind: "system", text: sentinelText(totalDropped), ts: sentinelTs }
  return [sentinel, ...tail]
}

/* --------------------------------------------------------------------- */
/*  Noise filtering — Claude Code internal wrapper tags                   */
/* --------------------------------------------------------------------- */

/**
 * Tags Claude Code wraps around model-only context that has no business
 * showing up in the chat UI. The user sees these as noise rows like:
 *
 *     > <local-command-caveat>Caveat: The messages below were
 *       generated by the user while running local commands. DO NOT
 *       respond to these messages…</local-command-caveat>
 *
 * They're injected when the user runs a `!shell` command, when the
 * harness hands the model a `<system-reminder>`, etc. We strip the
 * whole tag (including content) at message-ingest time; if a row is
 * left empty after stripping we drop it entirely so the chat doesn't
 * show a bare `>` chip with nothing next to it.
 */
const CLAUDE_NOISE_TAGS = [
  "local-command-caveat",
  "command-message",
  "command-name",
  "command-args",
  "command-stdout",
  "command-stderr",
  "bash-input",
  "bash-stdout",
  "bash-stderr",
  "system-reminder",
] as const

const NOISE_TAG_PATTERN = new RegExp(`<(${CLAUDE_NOISE_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`, "gi")

/**
 * Strip Claude-Code-internal wrapper blocks from chat text. Pure: no
 * tag = no allocation past the regex check. Trims trailing whitespace
 * left behind when a stripped block was the only thing on a line.
 */
export function cleanChatText(text: string): string {
  if (!text || text.indexOf("<") === -1) return text
  return text.replace(NOISE_TAG_PATTERN, "").trim()
}

/**
 * One queued user prompt awaiting dispatch.
 *
 * The queue exists to support submissions while a turn is already
 * streaming — the user types Enter and we stash the prompt here
 * instead of either rejecting it or interrupting the in-flight model.
 * Mirrors the `'later'` priority slot in claude-code's
 * `refs/claude-code/src/utils/messageQueueManager.ts` (single FIFO,
 * priority-driven). `kind: 'queued'` rows are NOT chat rows — they
 * never appear in `messages` and don't survive the JSONL replay; they
 * live alongside `messages` in {@link ChatState} and are drained by
 * the chat shell when streaming flips false.
 */
/**
 * Queued user-initiated work pending dispatch when streaming ends.
 * Discriminated by `kind` so the chat shell can route the head item
 * to the right consumer (prompt → engine, bash → local subprocess) —
 * matches claude-code's queue-by-mode behavior in
 * `refs/claude-code/src/utils/handlePromptSubmit.ts:336` where a mid-
 * stream `!cmd` enqueues with `mode: 'bash'` and the drain runs
 * `processBashCommand` instead of `processTextPrompt`. The two shapes
 * carry different payload fields (`text` vs `command`) because
 * conflating them under a single `text` slot lost the type discriminator
 * downstream — the drain needed an explicit kind to fork on.
 */
export type QueuedPrompt =
  | { readonly id: string; readonly kind: "prompt"; readonly text: string; readonly ts: string }
  | { readonly id: string; readonly kind: "bash"; readonly command: string; readonly ts: string }

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
   * status (see the `user_input.resolved` handler in {@link applyEvent})
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

/** One completed bash interaction waiting to be folded into the next prompt. */
export interface PendingBashContext {
  readonly command: string
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

/** Build the initial state. Used at mount and on task switch. */
export function createInitialState(): ChatState {
  return {
    messages: [],
    isStreaming: false,
    error: null,
    queue: [],
  }
}

/**
 * Soft cap on queued prompts. Past this we reject further enqueues
 * with a system row instead of growing the queue without bound.
 * 50 leaves plenty of headroom for spam-typing several thoughts in
 * a row without rejecting; the user can still hit the cap by
 * actively trying. claude-code itself has no documented cap.
 */
export const QUEUE_SOFT_CAP = 50

/**
 * Replace messages from `engine.readHistory(sessionId)`. Called once
 * per task mount. Clears nothing else (history load is independent of
 * streaming state — typically nothing's streaming at mount anyway).
 *
 * Walks each message's content blocks and produces one or more
 * ChatRows per message:
 *   - `text` block → user/assistant/system row (per role)
 *   - `tool_use` block → tool row with `done: false` + `toolUseId`
 *   - `tool_result` block → patches the matching tool row (by
 *     `tool_use_id`) to `done: true` + `output`; emits NO row of
 *     its own (the tool result lives on the tool row, not as a
 *     standalone user row)
 *   - `thinking` and other unrecognised blocks → dropped
 *
 * Messages whose content is purely tool blocks produce no text row
 * (so we don't litter the chat with empty `⏺`/`>` rows for assistant
 * messages that only invoked tools or user messages that only
 * carried tool results).
 */
export function setMessagesFromHistory(
  state: ChatState,
  past: readonly Message[],
  usageMetrics?: SessionUsageMetrics,
): ChatState {
  const rows: ChatRow[] = []
  // tool_use_id → index into `rows`. Used to back-patch when the
  // matching `tool_result` arrives on a later message.
  const toolIndexById = new Map<string, number>()

  for (const m of past) {
    appendRowsFromMessage(rows, toolIndexById, m)
  }

  // Rehydrate the context meter from engine-owned persisted usage.
  const latestUsage = usageMetrics

  // Apply the cap on the hydration path too — don't load 5000
  // historical rows just to drop 4000 immediately on the next delta.
  return {
    ...state,
    messages: capMessages(rows, new Date().toISOString()),
    ...(latestUsage ? { lastUsage: latestUsage } : {}),
  }
}

/** Append a freshly-submitted user prompt. Sets `isStreaming: true`. */
export function pushUser(state: ChatState, prompt: string, nowIso: string = new Date().toISOString()): ChatState {
  return {
    ...state,
    isStreaming: true,
    error: null,
    lastUsage: undefined,
    activeTurnStartedAt: nowIso,
    messages: capMessages([...state.messages, { kind: "user", text: prompt, ts: nowIso }], nowIso),
  }
}

/**
 * Append a prompt to the queue. Returns the same state when the queue
 * is full (use {@link queueIsFull} to detect and surface a hint to the
 * user). Each entry gets a unique id — the chat shell uses it to tie
 * the cancel button on the rendered queue row back to the right entry.
 *
 * The id is `q-<ts>-<random>`; the random tail keeps two enqueues in
 * the same millisecond distinct (Date.now() granularity isn't fine
 * enough on fast machines).
 */
export function enqueuePrompt(state: ChatState, prompt: string, nowIso: string = new Date().toISOString()): ChatState {
  if (state.queue.length >= QUEUE_SOFT_CAP) return state
  const id = `q-${nowIso}-${Math.random().toString(36).slice(2, 8)}`
  return {
    ...state,
    queue: [...state.queue, { id, kind: "prompt", text: prompt, ts: nowIso }],
  }
}

/**
 * Append a `!shell` command to the queue. Same FIFO + cap rules as
 * {@link enqueuePrompt}. Used by the bash submit path when the engine
 * is already streaming — the command waits until the current turn
 * finishes, then the queue-drain microtask runs it locally (no model
 * query). Mirrors claude-code's `enqueue({ mode: 'bash', ... })` in
 * `refs/claude-code/src/utils/handlePromptSubmit.ts`.
 */
export function enqueueBashCommand(
  state: ChatState,
  command: string,
  nowIso: string = new Date().toISOString(),
): ChatState {
  if (state.queue.length >= QUEUE_SOFT_CAP) return state
  const id = `q-${nowIso}-${Math.random().toString(36).slice(2, 8)}`
  return {
    ...state,
    queue: [...state.queue, { id, kind: "bash", command, ts: nowIso }],
  }
}

/** Whether enqueuePrompt would refuse the next prompt. */
export function queueIsFull(state: ChatState): boolean {
  return state.queue.length >= QUEUE_SOFT_CAP
}

/**
 * Pop the head of the queue. Returns `[nextState, dequeued]` so the
 * caller can dispatch the prompt. Both fields are stable when the
 * queue is empty: `[state, null]`.
 */
export function dequeueFirst(state: ChatState): [ChatState, QueuedPrompt | null] {
  if (state.queue.length === 0) return [state, null]
  const [head, ...rest] = state.queue
  if (!head) return [state, null]
  return [{ ...state, queue: rest }, head]
}

/** Remove a queued prompt by id (the cancel-button path). */
export function removeFromQueue(state: ChatState, id: string): ChatState {
  if (state.queue.length === 0) return state
  const next = state.queue.filter((q) => q.id !== id)
  if (next.length === state.queue.length) return state
  return { ...state, queue: next }
}

/** Wipe the queue. Used on task switch / tab close. */
export function clearQueue(state: ChatState): ChatState {
  if (state.queue.length === 0) return state
  return { ...state, queue: [] }
}

/* --------------------------------------------------------------------- */
/*  Bash mode — !shell command rows + pending context                     */
/* --------------------------------------------------------------------- */

/**
 * Append a fresh `bash` row for an in-flight `!shell` command. The row
 * starts with empty stdout/stderr and `done: false`; subsequent
 * {@link patchBashRow} calls stream output into it as the child process
 * emits data. `id` is a caller-generated stable token (used to patch
 * the row by reference without a name-based fallback like
 * {@link applyEvent}'s tool-result path).
 */
export function pushBashRow(
  state: ChatState,
  args: { id: string; command: string },
  nowIso: string = new Date().toISOString(),
): ChatState {
  return {
    ...state,
    messages: capMessages(
      [
        ...state.messages,
        {
          kind: "bash",
          id: args.id,
          command: args.command,
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          done: false,
          ts: nowIso,
        },
      ],
      nowIso,
    ),
  }
}

/**
 * Patch an in-flight bash row by id. Used to (a) append streamed bytes
 * to `stdout` / `stderr`, and (b) flip `done: true` with the final
 * `exitCode` / `signal` on process exit. No-op if the row isn't found
 * (e.g. truncated by the scrollback cap mid-stream).
 */
export function patchBashRow(
  state: ChatState,
  id: string,
  patch: {
    stdoutAppend?: string
    stderrAppend?: string
    exitCode?: number | null
    signal?: string | null
    done?: boolean
  },
): ChatState {
  const idx = findLastIndex(state.messages, (m) => m.kind === "bash" && m.id === id)
  if (idx < 0) return state
  const target = state.messages[idx] as Extract<ChatRow, { kind: "bash" }>
  const next = state.messages.slice()
  next[idx] = {
    ...target,
    stdout: patch.stdoutAppend ? target.stdout + patch.stdoutAppend : target.stdout,
    stderr: patch.stderrAppend ? target.stderr + patch.stderrAppend : target.stderr,
    exitCode: patch.exitCode !== undefined ? patch.exitCode : target.exitCode,
    signal: patch.signal !== undefined ? patch.signal : target.signal,
    done: patch.done !== undefined ? patch.done : target.done,
  }
  return { ...state, messages: next }
}

/**
 * Append a completed bash interaction to the pending-context FIFO. The
 * next regular (non-bash) submit drains this and prepends the entries
 * as XML to the prompt sent to the engine.
 */
export function pushPendingBashContext(state: ChatState, ctx: PendingBashContext): ChatState {
  const prev = state.pendingBashContext ?? []
  return { ...state, pendingBashContext: [...prev, ctx] }
}

/**
 * Drain the pending bash-context FIFO. Returns the cleared state and
 * the drained entries so the caller can format them into a prompt
 * prefix. Empty input returns `[state, []]` without allocating.
 */
export function drainPendingBashContext(state: ChatState): [ChatState, readonly PendingBashContext[]] {
  const list = state.pendingBashContext ?? []
  if (list.length === 0) return [state, []]
  // Re-spread without the field rather than `delete`-on-copy — biome's
  // `noDelete` flags the latter for the runtime hidden-class penalty
  // even though copies pay it once.
  const { pendingBashContext: _drop, ...rest } = state
  void _drop
  return [{ ...rest }, list]
}

/**
 * Format a list of completed bash interactions as the XML prefix
 * Claude-Code adds to the next regular user prompt. Matches upstream's
 * tags so the model parses the bytes the same way — kobe's chat UI
 * strips these via {@link cleanChatText} on history replay, so the
 * prefix is invisible in the transcript but visible to the model.
 *
 * Empty list → empty string (zero allocation).
 */
export function formatBashContextPrefix(entries: readonly PendingBashContext[]): string {
  if (entries.length === 0) return ""
  const parts: string[] = []
  for (const e of entries) {
    parts.push(`<bash-input>${escapeXml(e.command)}</bash-input>`)
    if (e.stdout.length > 0) parts.push(`<bash-stdout>${escapeXml(e.stdout)}</bash-stdout>`)
    if (e.stderr.length > 0) parts.push(`<bash-stderr>${escapeXml(e.stderr)}</bash-stderr>`)
  }
  parts.push("") // trailing blank line separating context from the actual prompt
  return parts.join("\n")
}

/** Escape the five XML metacharacters. Minimal — kobe never round-trips
 *  this through an XML parser; the model just sees the bytes. */
function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&amp;"
    if (c === "<") return "&lt;"
    if (c === ">") return "&gt;"
    if (c === '"') return "&quot;"
    return "&apos;"
  })
}

/**
 * Apply a single {@link OrchestratorEvent} to the state. Pure.
 *
 *   - `assistant.delta`: append a new assistant row, OR concat into the
 *     last assistant row if it's the most recent message (token-level
 *     streaming would benefit from that; Claude Code emits one delta
 *     per turn so this is mostly the "append" case in practice).
 *   - `tool.start`: push a `tool` row with `done: false`.
 *   - `tool.result`: walk back to the most recent unfinished tool row
 *     with the same `name`, set its `output` and `done`. If no match,
 *     push a standalone tool row.
 *   - `usage`: record {@link ChatState.lastUsage} for the context meter; messages unchanged.
 *   - `done`: `isStreaming: false`.
 *   - `error`: append a `system` row + `isStreaming: false` + banner.
 *   - `user.inject`: append a user row with the injected text and set
 *     `isStreaming: true`. Synthesized by the orchestrator for prompt
 *     injections (e.g. the Create-PR button) so the chat shows the
 *     injected prompt the same way it shows a typed user prompt.
 */
export function applyEvent(
  state: ChatState,
  ev: OrchestratorEvent,
  nowIso: string = new Date().toISOString(),
): ChatState {
  switch (ev.type) {
    case "reasoning.delta": {
      if (ev.text.length === 0) return state
      const last = state.messages[state.messages.length - 1]
      if (last && last.kind === "reasoning") {
        const merged: ChatRow = { kind: "reasoning", text: last.text + ev.text, ts: last.ts }
        return {
          ...state,
          isStreaming: true,
          messages: [...state.messages.slice(0, -1), merged],
        }
      }
      return {
        ...state,
        isStreaming: true,
        messages: capMessages([...state.messages, { kind: "reasoning", text: ev.text, ts: nowIso }], nowIso),
      }
    }
    case "assistant.delta": {
      const last = state.messages[state.messages.length - 1]
      if (last && last.kind === "assistant") {
        // Concat into the last assistant row (handles token-by-token
        // streaming gracefully if the engine ever switches to that).
        // No length change → no truncation needed; the live in-flight
        // row stays at the tail and is preserved.
        const merged: ChatRow = { kind: "assistant", text: last.text + ev.text, ts: last.ts }
        return {
          ...state,
          isStreaming: true,
          messages: [...state.messages.slice(0, -1), merged],
        }
      }
      return {
        ...state,
        isStreaming: true,
        messages: capMessages([...state.messages, { kind: "assistant", text: ev.text, ts: nowIso }], nowIso),
      }
    }
    case "tool.start":
      return {
        ...state,
        messages: capMessages(
          [...state.messages, { kind: "tool", name: ev.name, input: ev.input, done: false, ts: nowIso }],
          nowIso,
        ),
      }
    case "tool.result": {
      // Find the most recent unfinished tool row with this name and
      // patch it. If none, append a standalone result row.
      const idx = findLastIndex(state.messages, (m) => m.kind === "tool" && !m.done && m.name === ev.name)
      if (idx >= 0) {
        const target = state.messages[idx] as Extract<ChatRow, { kind: "tool" }>
        const patched: ChatRow = { ...target, output: ev.output, done: true }
        const next = state.messages.slice()
        next[idx] = patched
        // In-place patch — no length change, cap not needed.
        return { ...state, messages: next }
      }
      return {
        ...state,
        messages: capMessages(
          [
            ...state.messages,
            { kind: "tool", name: ev.name, input: undefined, output: ev.output, done: true, ts: nowIso },
          ],
          nowIso,
        ),
      }
    }
    case "usage":
      return {
        ...state,
        lastUsage: {
          input_tokens: ev.input_tokens,
          output_tokens: ev.output_tokens,
          cache_read_input_tokens: ev.cache_read_input_tokens,
          cache_creation_input_tokens: ev.cache_creation_input_tokens,
          context_tokens: ev.context_tokens,
          context_tokens_approximate: ev.context_tokens_approximate,
          context_window_tokens: ev.context_window_tokens,
          total_speed_tokens_per_second: ev.total_speed_tokens_per_second,
        },
      }
    case "done":
      return { ...state, isStreaming: false, activeTurnStartedAt: undefined }
    case "error":
      return {
        ...state,
        isStreaming: false,
        activeTurnStartedAt: undefined,
        error: ev.message,
        messages: capMessages(
          [...state.messages, { kind: "system", text: `error: ${ev.message}`, ts: nowIso }],
          nowIso,
        ),
      }
    case "user.inject": {
      // Strip claude-code wrapper tags (e.g. `<bash-input>` from the
      // KOB-83 bash-mode prefix, `<command-name>` from a slash command,
      // `<system-reminder>` from harness injections) so the user row
      // shows only the human-meaningful text. The history-replay path
      // (`appendRowsFromMessage` → `cleanChatText`) already does this;
      // mirror it on the live event path so a freshly-dispatched
      // user.inject doesn't render the raw XML before the next mount.
      const cleaned = cleanChatText(ev.text)
      // Drop the row entirely when stripping leaves nothing — bash mode
      // can fire the bash-context prefix WITHOUT any trailing user text
      // (e.g. follow-up `!cmd` while a prompt is queued). Adding an
      // empty user row would render a bare `>` chip with nothing next
      // to it, matching the same suppression `cleanChatText` applies
      // during history hydration.
      if (cleaned.length === 0) {
        return { ...state, isStreaming: true, error: null, lastUsage: undefined, activeTurnStartedAt: nowIso }
      }
      return {
        ...state,
        isStreaming: true,
        error: null,
        lastUsage: undefined,
        activeTurnStartedAt: nowIso,
        messages: capMessages([...state.messages, { kind: "user", text: cleaned, ts: nowIso }], nowIso),
      }
    }
    case "system.info":
      // Dim status note from the orchestrator (worktree allocated,
      // branch renamed, etc). Renders as a `system` row in muted
      // text — see MessageList's SystemRow / `isError` predicate
      // which only flips to error styling on "error:"/"runTask
      // failed" prefixes, neither of which we use here.
      return {
        ...state,
        messages: capMessages([...state.messages, { kind: "system", text: ev.text, ts: nowIso }], nowIso),
      }
    case "chat.tab.cleared":
      // `/clear` slash command. Wipe the tab back to a freshly-mounted
      // shape — no messages, no streaming flag, no queue, no pending
      // approval, no usage meter. The orchestrator has already dropped
      // the tab's sessionId server-side so the next runTask spawns a
      // new Claude session instead of resuming the old one.
      return createInitialState()
    case "user_input.request": {
      // Subprocess has exited (the tool runs to completion in -p mode
      // and just leaves a marker), so streaming flips off — the
      // approval / question row IS the new "active" UI affordance,
      // not a spinner. Each kind appends a different ChatRow shape.
      if (ev.payload.kind === "approve_plan") {
        return {
          ...state,
          isStreaming: false,
          messages: capMessages(
            [
              ...state.messages,
              {
                kind: "approval",
                requestId: ev.requestId,
                tool: "ExitPlanMode",
                plan: ev.payload.plan,
                filePath: ev.payload.filePath,
                status: "pending",
                ts: nowIso,
              },
            ],
            nowIso,
          ),
        }
      }
      if (ev.payload.kind === "ask_question") {
        return {
          ...state,
          isStreaming: false,
          messages: capMessages(
            [
              ...state.messages,
              {
                kind: "question",
                requestId: ev.requestId,
                questions: ev.payload.questions,
                answers: null,
                ts: nowIso,
              },
            ],
            nowIso,
          ),
        }
      }
      return state
    }
    case "user_input.resolved": {
      // Find the matching pending row and patch its terminal state.
      // We don't remove the row — keep the question/plan visible so
      // the user can scroll back and remember what they answered.
      // In-place patch — no length change, cap not needed.
      const idx = findLastIndex(state.messages, (m) => {
        if (m.kind === "approval") return m.requestId === ev.requestId && m.status === "pending"
        if (m.kind === "question") return m.requestId === ev.requestId && m.answers === null
        return false
      })
      if (idx < 0) return state
      const target = state.messages[idx]
      let patched: ChatRow | null = null
      if (target?.kind === "approval" && ev.response.kind === "approve_plan") {
        patched = { ...target, status: ev.response.approve ? "approved" : "rejected" }
      } else if (target?.kind === "question" && ev.response.kind === "ask_question") {
        patched = { ...target, answers: ev.response.answers }
      }
      if (!patched) return state
      const next = state.messages.slice()
      next[idx] = patched
      return { ...state, messages: next }
    }
    default:
      return state
  }
}

/**
 * Push a system error from outside the engine event bus (e.g. a
 * `runTask` rejection). Adds a system row + clears streaming.
 */
export function pushSystemError(
  state: ChatState,
  message: string,
  nowIso: string = new Date().toISOString(),
): ChatState {
  return {
    ...state,
    isStreaming: false,
    error: message,
    messages: capMessages(
      [...state.messages, { kind: "system", text: `runTask failed: ${message}`, ts: nowIso }],
      nowIso,
    ),
  }
}

/** Convenience alias — used at task switch. */
export function reset(): ChatState {
  return createInitialState()
}

/* --------------------------------------------------------------------- */
/*  Helpers                                                               */
/* --------------------------------------------------------------------- */

/**
 * Walk one historical Message's neutral block list and append the
 * appropriate ChatRows to `rows`. `tool_call` creates a new tool row
 * (recorded in `toolIndexById`); `tool_result` patches the matching
 * row in place. `text` blocks become role-typed text rows; consecutive
 * texts buffer into one row so multi-text messages render as a single
 * paragraph.
 *
 * `thinking` blocks are intentionally dropped — kobe's live stream
 * parser drops them too, so hydration matches what the user saw live.
 */
function appendRowsFromMessage(rows: ChatRow[], toolIndexById: Map<string, number>, m: Message): void {
  const ts = m.timestamp

  // Buffer consecutive text blocks so a multi-`text` message renders as
  // one chat row, but flush before each tool block so the document
  // order (text, tool, text → text-row, tool-row, text-row) is
  // preserved in the chat.
  let textBuf = ""
  const flushText = () => {
    if (textBuf.length === 0) return
    const row = textRow(m.role, textBuf, ts)
    if (row) rows.push(row)
    textBuf = ""
  }

  for (const block of m.blocks) {
    if (block.type === "text") {
      textBuf += block.text
      continue
    }

    if (block.type === "tool_call") {
      flushText()
      const id = block.callId.length > 0 ? block.callId : undefined
      const row: ChatRow = {
        kind: "tool",
        name: block.name,
        input: block.input,
        done: false,
        ts,
        toolUseId: id,
      }
      const idx = rows.length
      rows.push(row)
      if (id) toolIndexById.set(id, idx)
      continue
    }

    if (block.type === "tool_result") {
      flushText()
      const id = block.callId.length > 0 ? block.callId : undefined
      const idx = id !== undefined ? toolIndexById.get(id) : undefined
      const output = block.output
      if (idx !== undefined) {
        const target = rows[idx]
        if (target && target.kind === "tool") {
          rows[idx] = { ...target, done: true, output }
        }
      } else {
        // Orphan tool_result (no matching tool_call seen). Render as a
        // standalone result row so the user can still see what came
        // back; matches the live `applyEvent` fallback for the same
        // case.
        rows.push({ kind: "tool", name: "", input: undefined, output, done: true, ts })
      }
    }
    // `thinking` (and any future block type) intentionally dropped.
  }

  flushText()
}

function textRow(role: Message["role"], text: string, ts: string): ChatRow | null {
  const cleaned = cleanChatText(text)
  if (cleaned.length === 0) return null
  if (role === "user") return { kind: "user", text: cleaned, ts }
  if (role === "assistant") return { kind: "assistant", text: cleaned, ts }
  return { kind: "system", text: cleaned, ts }
}

/** ES2023 `findLastIndex` polyfill (some target envs don't have it). */
function findLastIndex<T>(arr: readonly T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]
    if (v !== undefined && pred(v)) return i
  }
  return -1
}
