import { TextAttributes } from "@opentui/core"
import { type Accessor, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"

export type ComposerQueuedItem =
  | { readonly id: string; readonly kind: "prompt"; readonly text: string }
  | { readonly id: string; readonly kind: "bash"; readonly command: string }

/**
 * Hard cap on visible queued rows so a fast typist who stacked many
 * prompts doesn't push the textarea off-screen. Overflow rolls up
 * into a single muted `+ N more queued` summary row.
 */
const QUEUE_VISIBLE_CAP = 4

export interface ComposerQueueProps {
  readonly queue: readonly ComposerQueuedItem[]
  readonly editingQueueId?: Accessor<string | null>
  readonly onEditQueued?: (id: string) => void
  readonly onSendQueuedNow?: (id: string) => void
  readonly onCancelQueued?: (id: string) => void
}

export function ComposerQueue(props: ComposerQueueProps) {
  const { theme } = useTheme()
  return (
    <Show when={props.queue.length > 0}>
      <box flexDirection="column" paddingBottom={1}>
        <For each={props.queue.slice(0, QUEUE_VISIBLE_CAP)}>
          {(entry, idx) => {
            const isPrompt = entry.kind === "prompt"
            const isEditing = () => props.editingQueueId?.() === entry.id
            const onRowEdit = () => props.onEditQueued?.(entry.id)
            return (
              <box flexDirection="row" gap={1} alignItems="flex-start">
                <box
                  flexDirection="row"
                  gap={1}
                  alignItems="flex-start"
                  flexGrow={1}
                  onMouseUp={isPrompt ? onRowEdit : undefined}
                >
                  <text fg={isEditing() ? theme.primary : theme.textMuted} attributes={TextAttributes.BOLD}>
                    ○
                  </text>
                  <text fg={theme.textMuted} wrapMode="none">
                    queued{idx() === 0 ? " (next)" : ""}:
                  </text>
                  <Show when={entry.kind === "bash"}>
                    <text fg={theme.warning} wrapMode="none">
                      (bash)
                    </text>
                  </Show>
                  <box flexGrow={1}>
                    <text fg={theme.text}>{entry.kind === "bash" ? entry.command : entry.text}</text>
                  </box>
                </box>
                <Show when={isPrompt}>
                  {/* Single-letter chip — consistent with the `[↑]` send-now
                      and `[x]` cancel chips on the same row. Pure ASCII so it
                      renders identically everywhere (the `✎` pencil dingbat
                      rendered thin/ugly across terminals); `e` mirrors `x`'s
                      letter-mnemonic shape. */}
                  <text fg={theme.primary} attributes={TextAttributes.BOLD} onMouseUp={onRowEdit}>
                    [e]
                  </text>
                </Show>
                <text
                  fg={theme.primary}
                  attributes={TextAttributes.BOLD}
                  onMouseUp={() => props.onSendQueuedNow?.(entry.id)}
                >
                  [↑]
                </text>
                <text
                  fg={theme.error}
                  attributes={TextAttributes.BOLD}
                  onMouseUp={() => props.onCancelQueued?.(entry.id)}
                >
                  [x]
                </text>
              </box>
            )
          }}
        </For>
        <Show when={props.queue.length > QUEUE_VISIBLE_CAP}>
          <box flexDirection="row" gap={1} alignItems="flex-start">
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              +
            </text>
            <text fg={theme.textMuted}>{`… ${props.queue.length - QUEUE_VISIBLE_CAP} more queued`}</text>
          </box>
        </Show>
      </box>
    </Show>
  )
}
