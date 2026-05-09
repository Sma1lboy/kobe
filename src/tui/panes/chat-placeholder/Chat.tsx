/**
 * Minimal chat placeholder for Gate G2.
 *
 * EXPLICITLY TEMPORARY — Wave 3 Stream G replaces this file with a
 * proper chat pane (history-loading, tool-call expansion, multi-line
 * composer). The job here is to prove end-to-end wiring: the user
 * types a prompt, presses enter, the orchestrator runs the engine,
 * the assistant deltas stream back into this pane.
 *
 * What we render:
 *   - A scrolling message log: each `assistant.delta` accumulates onto
 *     the current assistant message; tool.start / tool.result render
 *     as a single collapsed line each.
 *   - A single-line input at the bottom, focused while the pane is
 *     mounted. Enter submits.
 *   - On task switch, we tear down the previous subscription and
 *     reset state.
 *
 * What we do NOT do:
 *   - Load Claude Code JSONL history (Wave 3 G).
 *   - Render markdown / code / tool-call expansion (Wave 3 G).
 *   - Multi-line input (Wave 3 G — needs `<textarea>`).
 *   - Local message buffer (we render straight from the live event
 *     stream; switching tasks loses history. Acceptable for G2.)
 */

import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import type { Orchestrator } from "../../../orchestrator/core.ts"
import type { EngineEvent } from "../../../types/engine.ts"
import type { TaskId } from "../../../types/task.ts"
import { useTheme } from "../../context/theme"

/**
 * Simplified chat-line union. We rebuild this from the EngineEvent
 * stream rather than persisting the raw events: the chat pane only
 * needs the displayable shape, and Wave 3 will replace this file
 * entirely anyway.
 */
type ChatLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; label: string }
  | { kind: "system"; text: string }

export type ChatPlaceholderProps = {
  orchestrator: Orchestrator
  /**
   * Currently selected task. When this changes we tear down the
   * previous subscription and reset state. `undefined` means no task
   * selected — render the empty state.
   */
  taskId: TaskId | string | undefined
  /**
   * Optional title for the active task, surfaced in the header so the
   * user can see which task they're chatting with.
   */
  title?: string
}

export function ChatPlaceholder(props: ChatPlaceholderProps) {
  const { theme } = useTheme()
  const [lines, setLines] = createSignal<ChatLine[]>([])
  const [draft, setDraft] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  // (Re)subscribe on task change. The `on` helper makes the dependency
  // explicit so we don't rerun on every signal access inside the body.
  createEffect(
    on(
      () => props.taskId,
      (taskId, _prev, prevCleanup?: () => void) => {
        prevCleanup?.()
        setLines([])
        setDraft("")
        setBusy(false)
        if (!taskId) return undefined
        const unsubscribe = props.orchestrator.subscribeEvents(taskId, (ev) => onEvent(ev))
        return unsubscribe
      },
    ),
  )

  // The subscription returned from `createEffect`'s callback above is
  // stored as the next-iteration's `prevCleanup`. We don't have an
  // explicit onCleanup for the final unmount because the orchestrator
  // GCs subscriber sets when empty; but tear it down anyway so we're
  // tidy.
  onCleanup(() => {
    setLines([])
  })

  function onEvent(ev: EngineEvent) {
    if (ev.type === "assistant.delta") {
      setLines((cur) => {
        const last = cur[cur.length - 1]
        if (last && last.kind === "assistant") {
          // Append onto the trailing assistant line.
          const next = cur.slice(0, -1)
          next.push({ kind: "assistant", text: last.text + ev.text })
          return next
        }
        return [...cur, { kind: "assistant", text: ev.text }]
      })
    } else if (ev.type === "tool.start") {
      setLines((cur) => [...cur, { kind: "tool", label: `tool: ${ev.name} (running)` }])
    } else if (ev.type === "tool.result") {
      setLines((cur) => [...cur, { kind: "tool", label: `tool: ${ev.name} (done)` }])
    } else if (ev.type === "done") {
      setBusy(false)
      setLines((cur) => [...cur, { kind: "system", text: "— done —" }])
    } else if (ev.type === "error") {
      setBusy(false)
      setLines((cur) => [...cur, { kind: "system", text: `error: ${ev.message}` }])
    }
    // usage events are ignored at this layer.
  }

  async function send(): Promise<void> {
    const text = draft().trim()
    const taskId = props.taskId
    if (!text || !taskId) return
    setLines((cur) => [...cur, { kind: "user", text }])
    setDraft("")
    setBusy(true)
    try {
      await props.orchestrator.runTask(taskId, text)
    } catch (err) {
      setBusy(false)
      setLines((cur) => [
        ...cur,
        { kind: "system", text: `runTask failed: ${err instanceof Error ? err.message : String(err)}` },
      ])
    }
  }

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={theme.background} paddingLeft={1} paddingRight={1}>
      <box paddingTop={1} paddingBottom={1} flexShrink={0}>
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          chat {props.title ? `— ${props.title}` : ""}
        </text>
        <Show when={!props.taskId}>
          <text fg={theme.textMuted}>No task selected. Press n to create one.</text>
        </Show>
      </box>

      <scrollbox
        flexGrow={1}
        stickyScroll={true}
        stickyStart="bottom"
        verticalScrollbarOptions={{
          trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
        }}
      >
        <box paddingRight={1} gap={0}>
          <For each={lines()}>
            {(line) => {
              if (line.kind === "user") {
                return (
                  <box paddingTop={1}>
                    <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                      you
                    </text>
                    <text fg={theme.text}>{line.text}</text>
                  </box>
                )
              }
              if (line.kind === "assistant") {
                return (
                  <box paddingTop={1}>
                    <text fg={theme.success} attributes={TextAttributes.BOLD}>
                      assistant
                    </text>
                    <text fg={theme.text}>{line.text}</text>
                  </box>
                )
              }
              if (line.kind === "tool") {
                return (
                  <box paddingTop={0}>
                    <text fg={theme.textMuted}>{line.label}</text>
                  </box>
                )
              }
              return (
                <box paddingTop={0}>
                  <text fg={theme.textMuted}>{line.text}</text>
                </box>
              )
            }}
          </For>
        </box>
      </scrollbox>

      <box flexShrink={0} paddingTop={1} flexDirection="row" gap={1}>
        <text fg={theme.textMuted}>{busy() ? "…" : ">"}</text>
        <box flexGrow={1}>
          <Show
            when={props.taskId !== undefined}
            fallback={<text fg={theme.textMuted}>(no task — press n to create)</text>}
          >
            <input
              value={draft()}
              placeholder="Ask Claude…"
              focused={true}
              onInput={(v: string) => setDraft(v)}
              onSubmit={() => {
                void send()
              }}
            />
          </Show>
        </box>
      </box>
    </box>
  )
}
