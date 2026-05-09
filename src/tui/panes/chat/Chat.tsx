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

import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { type Accessor, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
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

  // Reactive view of the active task's status. Read off the
  // orchestrator's tasksSignal (single source of truth — the Sidebar
  // mirrors the same data) so a delete-task / archive flips this in
  // the same tick. `canceled` is the only terminal state that blocks
  // the composer: the orchestrator rejects `canceled → in_progress`,
  // so further user input would just produce a `runTask failed:
  // illegal transition` system row.
  const taskStatus = createMemo(() => {
    const id = props.taskId()
    if (!id) return undefined
    return props.orchestrator
      .tasksSignal()()
      .find((t) => t.id === id)?.status
  })
  const isCanceled = () => taskStatus() === "canceled"

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
              // History just landed: jump to the most recent message
              // unconditionally. The follow-mode createEffect won't
              // catch this case because the scrollbox was sitting at
              // scrollTop=0 with a small scrollHeight before the load.
              queueMicrotask(scrollToBottom)
            })
            .catch((err) => {
              setState((s) => pushSystemError(s, `history load failed: ${stringifyErr(err)}`))
            })
        }
        // Task switch resets the viewport regardless of history outcome
        // (e.g. brand-new task with no sessionId).
        queueMicrotask(scrollToBottom)

        return unsubscribe
      },
    ),
  )

  // Scroll anchor — used to force the message list back to the bottom
  // when the chat tab (re)opens or the user switches tasks. opentui's
  // `stickyScroll` keeps follow-mode working for *incremental* growth,
  // but it doesn't re-anchor when content is loaded asynchronously
  // (history fetch) or when the scrollbox is freshly mounted with
  // pre-existing messages — both common paths here. We explicitly call
  // `scrollTo` on mount, on task switch, and right after history lands.
  let scrollRef: ScrollBoxRenderable | undefined
  function scrollToBottom(): void {
    const r = scrollRef
    if (!r) return
    r.scrollTo({ x: 0, y: r.scrollHeight })
  }

  onMount(() => {
    queueMicrotask(scrollToBottom)
  })

  // After every render that could grow the list, snap to the bottom —
  // BUT only while the user is still in follow mode (scrollTop near
  // scrollHeight). If they've manually scrolled up to read history,
  // don't yank them back. The 2-row tolerance accounts for the
  // padding that lives at the top of the message list.
  createEffect(() => {
    void state().messages.length
    queueMicrotask(() => {
      const r = scrollRef
      if (!r) return
      const distanceFromBottom = r.scrollHeight - r.scrollTop - r.height
      if (distanceFromBottom <= 2) r.scrollTo({ x: 0, y: r.scrollHeight })
    })
  })

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
    // Defense-in-depth: orchestrator rejects `canceled → in_progress`
    // with IllegalTransitionError. The composer is hidden when
    // canceled, but the pending-prompt path can still reach `send()`
    // — bail before runTask so the chat doesn't pick up a stray error
    // banner from a transition that's expected to fail.
    if (isCanceled()) return
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

  // Spinner shows whenever a turn is in flight — independent of how
  // many assistant rows already exist. Earlier this was gated on
  // `lastAssistantIdx() === -1` (intent: hide once the streaming cursor
  // takes over). The gate misfired on every turn after the first
  // because `lastAssistantIdx` scans the whole transcript, so a
  // prior-turn assistant row kept the spinner suppressed forever.
  // Claude Code itself keeps the spinner up alongside the streamed text
  // (`refs/claude-code/src/components/Spinner/SpinnerAnimationRow.tsx`).
  const showThinking = createMemo(() => state().isStreaming)

  // Wall-clock turn start. Latched when isStreaming flips false→true,
  // cleared on done/error/task-switch. Feeds Loading's elapsed timer.
  const [turnStartedAt, setTurnStartedAt] = createSignal<number | undefined>(undefined)
  createEffect(() => {
    if (state().isStreaming) {
      setTurnStartedAt((cur) => cur ?? Date.now())
    } else {
      setTurnStartedAt(undefined)
    }
  })

  // Chars of assistant text in the *current* turn — sum after the most
  // recent user row. Drives Loading's token estimate (chars/4, mirroring
  // Claude Code's `SpinnerAnimationRow` `leaderTokens` heuristic).
  const currentTurnChars = createMemo(() => {
    const msgs = state().messages
    let lastUserIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.kind === "user") {
        lastUserIdx = i
        break
      }
    }
    let chars = 0
    for (let i = lastUserIdx + 1; i < msgs.length; i++) {
      const r = msgs[i]
      if (r && r.kind === "assistant") chars += r.text.length
    }
    return chars
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
          ref={(r: ScrollBoxRenderable) => {
            scrollRef = r
          }}
          flexGrow={1}
          stickyScroll={true}
          stickyStart="bottom"
          verticalScrollbarOptions={{
            trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
          }}
        >
          <box paddingRight={1} gap={0}>
            {/* Wave 4.B — message render delegated to MessageList for
                Claude-Code parity (BLACK_CIRCLE prefix, markdown body,
                tool banner shape, thinking spinner glyph set). */}
            <MessageList
              messages={state().messages}
              isStreaming={state().isStreaming}
              lastAssistantIdx={lastAssistantIdx()}
              expandedToolIndex={expandedToolIndex()}
              onToggleTool={toggleExpand}
              showThinking={showThinking()}
              thinkingStartedAt={turnStartedAt()}
              thinkingResponseChars={currentTurnChars()}
              error={state().error}
            />
          </box>
        </scrollbox>
      </Show>

      {/* Composer. */}
      <Composer
        draft={draft()}
        onDraftChange={setDraft}
        isStreaming={state().isStreaming}
        hasTask={props.taskId() !== undefined && !isCanceled()}
        noTaskMessage={isCanceled() ? "(task canceled — pick another or press ctrl+n to create)" : undefined}
        onSubmit={handleComposerSubmit}
        focused={props.focused}
        historyKey={props.taskId()}
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
