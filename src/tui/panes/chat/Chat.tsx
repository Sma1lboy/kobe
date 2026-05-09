/**
 * Chat pane — shell.
 *
 * After Wave 4's split, this file owns ONLY:
 *   - State: `state` (ChatState), `draft`, `expandedToolIndex`.
 *   - Effects: task-switch resubscribe + history reload, pending-prompt
 *     auto-submit, unmount tidy-up.
 *   - Submit pipeline: `send()` (used by both onSubmit + auto-prompt).
 *   - Layout: header, scrollbox container, MessageList, Composer.
 *
 * Render details (MessageRow, formatting helpers) live in
 * `./MessageList.tsx`. Composer details (input box, placeholder) live
 * in `./Composer.tsx`. Wave-4 streams editing those files do not need
 * to touch this shell.
 *
 * State model — see `./store.ts` top-of-file. Single chronological
 * `messages: ChatRow[]`; user submits append; assistant deltas append
 * or coalesce; tool starts/results pair by name. Pure-data, vitest-
 * friendly.
 *
 * Lifecycle inside this component (still load-bearing):
 *
 *   - On `taskId()` change:
 *       1. Tear down the previous orchestrator subscription.
 *       2. Reset state (`createInitialState`).
 *       3. If the task has a `sessionId`, fire `engine.readHistory(sid)`
 *          and feed it to `setMessagesFromHistory`. Brand-new tasks have
 *          no sessionId yet — render an empty list.
 *       4. Subscribe to new task's events; each event flows into
 *          `applyEvent`.
 *
 *   - On user submit:
 *       1. `pushUser(state, prompt)` — sets `isStreaming: true` so the
 *          loading indicator appears that frame.
 *       2. `orchestrator.runTask(taskId, prompt)`. On rejection:
 *          `pushSystemError(state, message)`.
 *
 *   - On `pendingPrompt` (from new-task dialog): auto-submit it once,
 *     once the matching task is selected. Consumed via
 *     `onPendingPromptConsumed` so it doesn't re-fire on resubscribe.
 *
 * Load-bearing invariants (must NOT regress):
 *   - The "thinking" indicator must appear within one render frame of
 *     submit. The G3 behavior test asserts this.
 *   - Streaming text accumulates by appending each `assistant.delta`
 *     to the rolling render. We do NOT mutate.
 *   - Task switch tears down the prior subscription before subscribing
 *     to the new one (Solid `createEffect` returns the cleanup).
 */

import { TextAttributes } from "@opentui/core"
import { type Accessor, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { Orchestrator } from "../../../orchestrator/core.ts"
import type { OrchestratorEvent } from "../../../types/engine.ts"
import { useTheme } from "../../context/theme"
import { Composer } from "./Composer"
import { MessageList } from "./MessageList"
import {
  type ChatState,
  applyEvent,
  createInitialState,
  pushSystemError,
  pushUser,
  setMessagesFromHistory,
} from "./store"

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

        // Subscribe live events. Each event mutates the unified
        // `messages` array (user submits append directly, assistant
        // deltas append/coalesce, tool starts/results pair by name).
        // No re-read on done — the messages array IS the chronological
        // record while the session is live.
        const unsubscribe = props.orchestrator.subscribeEvents(taskId, (ev: OrchestratorEvent) => {
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
              setState((s) => setMessagesFromHistory(s, past))
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
    setState((s) => pushUser(s, text))
    try {
      await props.orchestrator.runTask(taskId, text)
    } catch (err) {
      setState((s) => pushSystemError(s, `runTask failed: ${stringifyErr(err)}`))
    }
  }

  // Render-derived: index of the trailing assistant row (anchor for the
  // streaming cursor) and trailing tool row (anchor for "enter expands").
  const lastAssistantIdx = createMemo(() => {
    const msgs = state().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const r = msgs[i]
      if (r && r.kind === "assistant") return i
    }
    return -1
  })

  const showThinking = createMemo(() => {
    if (!state().isStreaming) return false
    // Spinner only when no assistant text yet — once text streams in,
    // the cursor takes over and the spinner gets out of the way.
    return lastAssistantIdx() === -1
  })

  const lastToolIndex = createMemo(() => {
    const msgs = state().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const r = msgs[i]
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

  // Composer onSubmit: empty-string from the composer means "user hit
  // enter on an empty draft". We translate that into "expand the most
  // recent tool row" if there is one; otherwise it's a no-op (the
  // composer already swallowed the keystroke).
  function handleComposerSubmit(trimmed: string): void {
    if (trimmed.length === 0) {
      if (lastToolIndex() !== null) toggleExpandLastTool()
      return
    }
    void send()
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
          <MessageList
            messages={state().messages}
            isStreaming={state().isStreaming}
            lastAssistantIdx={lastAssistantIdx()}
            expandedToolIndex={expandedToolIndex()}
            onToggleTool={toggleExpand}
            showThinking={showThinking()}
            error={state().error}
          />
        </scrollbox>
      </Show>

      {/* Composer. */}
      <Composer
        draft={draft()}
        onDraftChange={setDraft}
        isStreaming={state().isStreaming}
        hasTask={props.taskId() !== undefined}
        onSubmit={handleComposerSubmit}
      />
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
