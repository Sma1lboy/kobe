/**
 * Wave 3 Stream G — chat pane.
 *
 * Replaces the throwaway `panes/chat-placeholder/Chat.tsx`. Owns the
 * entire chat surface for one selected task: header, message list,
 * loading indicator, streaming cursor, tool-call rendering, composer.
 *
 * State model — the {@link ChatState} from `./store.ts`. Two arrays
 * (past, live), one boolean (isStreaming), no separate loading flag,
 * no in-flight buffer. See store.ts top-of-file for the full rationale
 * and the pivot history.
 *
 * Lifecycle inside this component:
 *
 *   - On `taskId()` change:
 *       1. Tear down the previous orchestrator subscription.
 *       2. Reset state (`createInitialState`).
 *       3. If the task has a `sessionId`, fire `engine.readHistory(sid)`
 *          and feed it to `setPast`. Brand-new tasks have no sessionId
 *          yet — render an empty list.
 *       4. Subscribe to new task's events; each event flows into
 *          `applyEvent`.
 *
 *   - On user submit:
 *       1. `pushDraftUser(state, prompt)` — sets `isStreaming: true`
 *          immediately so the loading indicator appears that frame.
 *       2. `orchestrator.runTask(taskId, prompt)`. On rejection:
 *          `pushSystemError(state, message)`.
 *
 *   - On `pendingPrompt` (from new-task dialog): auto-submit it once,
 *     once the matching task is selected. The accessor is checked once
 *     per task switch; consumed via `onPendingPromptConsumed` so it
 *     doesn't re-fire on resubscribe.
 *
 * What's intentionally minimal (per the brief's "within reason"):
 *
 *   - Tool calls render as a single line `▶ <name>(<one-line-input>)`
 *     followed by a one-line result preview when present. Press
 *     `enter` (when the chat composer is empty) to expand the most
 *     recent tool call. Full details (json input + full output) shown
 *     on expand. Wave 4 owns rich rendering (per-arg syntax, syntax-
 *     highlighted output blobs, etc.).
 *   - Composer is single-line. Multi-line is Wave 4 (`shift-enter` to
 *     split). For now `\n` typed at the prompt is filtered out by the
 *     opentui input renderable anyway.
 *   - History rendering is text-only: `role: "user"|"assistant"` rows
 *     with `string`-coerced content. Tool messages from history are
 *     skipped in v1 (they re-appear during the next live run if the
 *     user resumes; otherwise, Wave 4 polish handles them).
 *
 * What's load-bearing (must NOT regress):
 *
 *   - The "thinking" indicator must appear within one render frame of
 *     submit. The G3 behavior test asserts this.
 *   - Streaming text accumulates by appending each `assistant.delta`
 *     to the rolling render. We do NOT mutate; the renderer reads the
 *     `live` array end-to-end every frame.
 *   - Task switch tears down the prior subscription before subscribing
 *     to the new one (Solid `createEffect` returns the cleanup; we
 *     return the unsubscribe).
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { Orchestrator } from "../../../orchestrator/core.ts"
import type { EngineEvent, Message } from "../../../types/engine.ts"
import { useTheme } from "../../context/theme"
import { Loading } from "./Loading"
import { type ChatState, applyEvent, createInitialState, pushDraftUser, pushSystemError, setPast } from "./store"

export type ChatProps = {
  orchestrator: Orchestrator
  /**
   * Solid accessor for the currently selected task id. We accept an
   * accessor (not a static prop) so task switches re-run effects
   * without React-style rerender ceremony.
   */
  taskId: Accessor<string | undefined>
  /** Active task title for the header. */
  title?: Accessor<string | undefined>
  /**
   * Optional pending prompt to auto-submit on first selection of the
   * matching task. Used by the new-task flow: the user types the
   * first prompt in the dialog, and we submit it on their behalf the
   * moment the task lands in the index. Accessor returns undefined
   * when there's nothing to submit.
   */
  pendingPrompt?: Accessor<string | undefined>
  /**
   * Called once we've consumed `pendingPrompt`. The parent uses this
   * to clear its pending-prompt signal so a re-subscribe (e.g. the
   * task gets re-selected after a switch) doesn't re-submit.
   */
  onPendingPromptConsumed?: () => void
  /** Future: focus management when multiple panes share input. Unused in v1. */
  focused?: Accessor<boolean>
}

/**
 * Coerce an unknown content blob from `engine.readHistory` into a
 * single string for display. The on-disk JSONL stores `content` as
 * either a plain string or an array of content blocks. We render
 * just the textual blocks; tool blocks are skipped in v1 (they
 * re-render via live events on the next run if the user resumes).
 */
function coerceHistoryContent(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block)
      } else if (block && typeof block === "object") {
        const b = block as { type?: unknown; text?: unknown }
        if (b.type === "text" && typeof b.text === "string") parts.push(b.text)
      }
    }
    return parts.join("")
  }
  return ""
}

/** One-line preview of a tool's input arg blob. */
function previewToolInput(input: unknown): string {
  if (input == null) return ""
  if (typeof input === "string") return collapseToOneLine(input, 60)
  try {
    return collapseToOneLine(JSON.stringify(input), 60)
  } catch {
    return "<unserializable>"
  }
}

function previewToolOutput(output: unknown): string {
  if (output == null) return ""
  if (typeof output === "string") return collapseToOneLine(output, 60)
  try {
    return collapseToOneLine(JSON.stringify(output), 60)
  } catch {
    return "<unserializable>"
  }
}

function collapseToOneLine(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max)}…`
}

/**
 * Walk a `live` event array and produce the render-ready row list. We
 * coalesce consecutive `assistant.delta` events into a single
 * "assistant" row — the renderer doesn't care that the engine emitted
 * the text in N chunks, the user just sees the concatenated string.
 *
 * Tool calls are paired in arrival order: each `tool.start` is matched
 * to the next `tool.result` with the same `name`. Unmatched starts
 * render with `output: undefined` (still running); unmatched results
 * (rare; happens if a result lands without a preceding start) render
 * standalone.
 */
type LiveRow =
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: unknown; output: unknown | undefined; done: boolean; index: number }

function buildLiveRows(live: readonly EngineEvent[]): LiveRow[] {
  const rows: LiveRow[] = []
  // We track per-name unfinished tool starts so a `tool.result` can
  // back-fill the right entry. This is the only "correlation" we do,
  // and it's done by walking `rows` not by a separate map — keeps the
  // state right next to what's rendered.
  for (const ev of live) {
    if (ev.type === "assistant.delta") {
      const last = rows[rows.length - 1]
      if (last && last.kind === "assistant") {
        // Coalesce consecutive deltas into the same row.
        rows[rows.length - 1] = { kind: "assistant", text: last.text + ev.text }
      } else {
        rows.push({ kind: "assistant", text: ev.text })
      }
    } else if (ev.type === "tool.start") {
      rows.push({
        kind: "tool",
        name: ev.name,
        input: ev.input,
        output: undefined,
        done: false,
        index: rows.length,
      })
    } else if (ev.type === "tool.result") {
      // Walk backward for the most recent unfinished tool with this name.
      let matched = false
      for (let i = rows.length - 1; i >= 0; i--) {
        const r = rows[i]
        if (r && r.kind === "tool" && !r.done && r.name === ev.name) {
          rows[i] = { ...r, output: ev.output, done: true }
          matched = true
          break
        }
      }
      if (!matched) {
        rows.push({
          kind: "tool",
          name: ev.name,
          input: undefined,
          output: ev.output,
          done: true,
          index: rows.length,
        })
      }
    }
    // usage / done / error don't contribute rows; the chat renders
    // pending/error from `state.isStreaming` and `state.error`.
  }
  return rows
}

/**
 * Render one history message row. We only display user/assistant text;
 * Claude Code's JSONL also contains tool-related entries which we skip
 * in v1 — they re-appear via live events on resume, and rendering them
 * properly is Wave 4 polish.
 */
function HistoryRow(props: { msg: Message }) {
  const { theme } = useTheme()
  const role = props.msg.role
  const text = createMemo(() => coerceHistoryContent(props.msg.content))
  if (role !== "user" && role !== "assistant") return null
  // Empty content = a tool-only block; skip.
  return (
    <Show when={text().length > 0}>
      <box paddingTop={1}>
        <text fg={role === "user" ? theme.accent : theme.success} attributes={TextAttributes.BOLD}>
          {role === "user" ? "you" : "assistant"}
        </text>
        <text fg={theme.text}>{text()}</text>
      </box>
    </Show>
  )
}

/**
 * Render one live row. Tool calls are collapsed by default; the parent
 * passes `expanded` and an `onToggle` shared between keyboard (composer
 * `enter` on empty draft) and mouse (`onMouseUp` on the tool row). Per
 * kobe's convention, every keyboard-interactive surface is also
 * click-interactive — same handler, both input modes.
 */
function LiveRowView(props: {
  row: LiveRow
  isLastAssistant: boolean
  isStreaming: boolean
  expanded: boolean
  onToggle: () => void
}) {
  const { theme } = useTheme()
  if (props.row.kind === "assistant") {
    return (
      <box paddingTop={1}>
        <text fg={theme.success} attributes={TextAttributes.BOLD}>
          assistant
        </text>
        <text fg={theme.text}>
          {props.row.text}
          {/* Streaming cursor: only on the last assistant row while a
              turn is still in flight. We use a thin vertical bar
              borrowed from terminal cursor convention. */}
          {props.isLastAssistant && props.isStreaming ? "▏" : ""}
        </text>
      </box>
    )
  }
  // Tool row.
  const r = props.row
  const status = r.done ? "done" : "running"
  const arrow = props.expanded ? "▼" : "▶"
  return (
    <box paddingTop={1}>
      {/* Click target — onMouseUp is opentui's "click released" event
          (Stream F's sidebar uses the same convention). The `enter`
          binding in the composer below routes to the same handler. */}
      <text fg={theme.textMuted} onMouseUp={() => props.onToggle()}>
        {arrow} {r.name}({previewToolInput(r.input)}) — {status}
      </text>
      <Show when={props.expanded}>
        <box paddingLeft={2} paddingTop={0}>
          <text fg={theme.textMuted}>input:</text>
          <text fg={theme.text}>{safeStringify(r.input)}</text>
          <Show when={r.done}>
            <text fg={theme.textMuted}>output:</text>
            <text fg={theme.text}>{safeStringify(r.output)}</text>
          </Show>
        </box>
      </Show>
      <Show when={!props.expanded && r.done}>
        <text fg={theme.textMuted} onMouseUp={() => props.onToggle()}>
          {" "}
          {previewToolOutput(r.output)}
        </text>
      </Show>
    </box>
  )
}

function safeStringify(v: unknown): string {
  if (v == null) return ""
  if (typeof v === "string") return v
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export function Chat(props: ChatProps) {
  const { theme } = useTheme()

  // The whole chat state lives in one signal. Solid's structural sharing
  // makes whole-state updates cheap; we don't bother with finer-grained
  // signals because the chat is small and the re-render cost is low.
  const [state, setState] = createSignal<ChatState>(createInitialState())
  const [draft, setDraft] = createSignal("")
  const [expandedToolIndex, setExpandedToolIndex] = createSignal<number | null>(null)

  // (Re)subscribe + reload history on task change. Solid's `on` makes
  // the dep explicit so we don't re-run on every signal access in the
  // body.
  createEffect(
    on(
      () => props.taskId(),
      (taskId, _prev, prevCleanup?: () => void) => {
        prevCleanup?.()
        // Fresh state for the new task; the in-progress turn (if any)
        // for the prior task is GC'd along with the prior subscription.
        setState(createInitialState())
        setDraft("")
        setExpandedToolIndex(null)
        if (!taskId) return undefined

        // Subscribe live events first so any deltas that fire during
        // the readHistory await don't get lost.
        const unsubscribe = props.orchestrator.subscribeEvents(taskId, (ev: EngineEvent) => {
          setState((s) => applyEvent(s, ev))
        })

        // Load history if the task already has a sessionId. Brand-new
        // tasks (just created via `n`) won't yet — that's fine, the
        // `live` events from the first run will populate the chat.
        const task = props.orchestrator.getTask(taskId)
        const sessionId = task?.sessionId ?? null
        if (sessionId) {
          props.orchestrator
            .readHistory(sessionId)
            .then((past) => {
              // Only apply if we haven't switched tasks since.
              if (props.taskId() !== taskId) return
              setState((s) => setPast(s, past))
            })
            .catch((err) => {
              setState((s) => pushSystemError(s, `history load failed: ${stringifyErr(err)}`))
            })
        }

        return unsubscribe
      },
    ),
  )

  // Pending-prompt watcher: separate from the task-switch effect
  // because the orchestrator's auto-select-first-task logic in app.tsx
  // can fire `setSelectedId` BEFORE the parent has staged the
  // pending prompt. Watching the prompt accessor in its own effect
  // means we react when EITHER the task or the prompt changes —
  // whichever comes second triggers the auto-submit.
  createEffect(() => {
    const pp = props.pendingPrompt?.()
    const taskId = props.taskId()
    if (!pp || !taskId) return
    if (pp.length === 0) return
    if (state().isStreaming) return
    // Consume immediately so a re-run (signal flicker, parent
    // re-mount) doesn't double-submit.
    props.onPendingPromptConsumed?.()
    queueMicrotask(() => {
      void send(pp)
    })
  })

  // Final unmount tidy-up — Solid runs the createEffect cleanup chain
  // for us, but a defensive reset is cheap.
  onCleanup(() => {
    setState(createInitialState())
  })

  /**
   * Submit a prompt. Pulls the active taskId from the accessor so this
   * is safe to call from the auto-pending-prompt path AND the
   * composer's onSubmit handler.
   */
  async function send(promptText?: string): Promise<void> {
    const text = (promptText ?? draft()).trim()
    const taskId = props.taskId()
    if (!text || !taskId) return
    if (state().isStreaming) {
      // Don't queue — keeping the model simple. We could buffer here
      // later if multi-turn rapid-fire becomes a real workflow.
      return
    }
    setDraft("")
    setState((s) => pushDraftUser(s, text))
    try {
      await props.orchestrator.runTask(taskId, text)
    } catch (err) {
      setState((s) => pushSystemError(s, `runTask failed: ${stringifyErr(err)}`))
    }
  }

  // Render-derived: live rows from the event buffer.
  const liveRows = createMemo(() => buildLiveRows(state().live))

  // Find the index of the last "assistant" row in liveRows so we can
  // anchor the streaming cursor there.
  const lastAssistantIdx = createMemo(() => {
    const rows = liveRows()
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (r && r.kind === "assistant") return i
    }
    return -1
  })

  // True iff the loading indicator should render. We show "thinking"
  // when a turn is in flight AND we have no in-flight assistant text
  // yet. Once text starts flowing, the streaming cursor takes over and
  // the spinner gets out of the way.
  const showThinking = createMemo(() => {
    if (!state().isStreaming) return false
    // If there's any assistant row in `live`, the cursor is rendering;
    // hide the spinner.
    return lastAssistantIdx() === -1
  })

  // The most recently-fired tool index (for the "press enter to expand"
  // affordance). null if there are no tool rows in the current live.
  const lastToolIndex = createMemo(() => {
    const rows = liveRows()
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i]
      if (r && r.kind === "tool") return i
    }
    return null
  })

  function toggleExpandLastTool(): void {
    const idx = lastToolIndex()
    if (idx == null) return
    setExpandedToolIndex((cur) => (cur === idx ? null : idx))
  }

  // Per-row toggler — used by both the click-on-tool-row handler and
  // the keyboard "enter on empty composer" path (which targets the
  // most recent tool row). Both eventually flow through this so the
  // expand/collapse model stays single-sourced.
  function toggleExpand(rowIndex: number): void {
    setExpandedToolIndex((cur) => (cur === rowIndex ? null : rowIndex))
  }

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Header */}
      <box paddingTop={1} paddingBottom={1} flexShrink={0} flexDirection="row" gap={1}>
        <text fg={theme.primary} attributes={TextAttributes.BOLD}>
          chat
        </text>
        <Show when={props.title?.()}>
          <text fg={theme.textMuted}>—</text>
          <text fg={theme.text}>{props.title?.()}</text>
        </Show>
      </box>

      {/* Empty state for "no task selected". */}
      <Show when={!props.taskId()}>
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>Select a task or press n to create one.</text>
        </box>
      </Show>

      {/* Message list. */}
      <Show when={props.taskId()}>
        <scrollbox
          flexGrow={1}
          stickyScroll={true}
          stickyStart="bottom"
          verticalScrollbarOptions={{
            trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
          }}
        >
          <box paddingRight={1} gap={0}>
            {/* Empty placeholder when we have neither past nor live. */}
            <Show when={state().past.length === 0 && state().live.length === 0 && !state().draftUser}>
              <box paddingTop={2}>
                <text fg={theme.textMuted}>Type a prompt below.</text>
              </box>
            </Show>

            {/* Persisted history. */}
            <For each={state().past}>{(msg) => <HistoryRow msg={msg} />}</For>

            {/* Just-submitted user row (lives only between submit and
                next setPast / task-switch). */}
            <Show when={state().draftUser}>
              {(draftUser) => (
                <box paddingTop={1}>
                  <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                    you
                  </text>
                  <text fg={theme.text}>{draftUser().text}</text>
                </box>
              )}
            </Show>

            {/* Live rows from the current run. */}
            <For each={liveRows()}>
              {(row, i) => (
                <LiveRowView
                  row={row}
                  isLastAssistant={i() === lastAssistantIdx()}
                  isStreaming={state().isStreaming}
                  expanded={row.kind === "tool" && expandedToolIndex() === i()}
                  onToggle={() => toggleExpand(i())}
                />
              )}
            </For>

            {/* Loading spinner while we're waiting for the first token. */}
            <Show when={showThinking()}>
              <Loading />
            </Show>

            {/* Error banner. */}
            <Show when={state().error}>
              <box paddingTop={1}>
                <text fg={theme.error}>error: {state().error}</text>
              </box>
            </Show>
          </box>
        </scrollbox>
      </Show>

      {/* Composer. */}
      <box flexShrink={0} paddingTop={1} flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>{state().isStreaming ? "…" : ">"}</text>
        <box flexGrow={1}>
          <Show
            when={props.taskId() !== undefined}
            fallback={<text fg={theme.textMuted}>(no task — press n to create)</text>}
          >
            <input
              value={draft()}
              placeholder={state().isStreaming ? "(streaming — wait for done)" : "Ask Claude…"}
              focused={true}
              onInput={(v: string) => setDraft(v)}
              onSubmit={() => {
                // Composer enter behavior:
                //  - If draft is empty AND there's a tool row, toggle
                //    its expansion (matches the brief: "press enter to
                //    expand" without stealing keystrokes mid-typing).
                //  - Otherwise, send the prompt.
                if (draft().trim().length === 0 && lastToolIndex() !== null) {
                  toggleExpandLastTool()
                  return
                }
                void send()
              }}
            />
          </Show>
        </box>
      </box>
    </box>
  )
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
