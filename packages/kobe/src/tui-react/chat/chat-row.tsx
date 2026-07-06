/** @jsxImportSource @opentui/react */
/**
 * React transcript row rendering for the native chat pane (`chat-pane.tsx`)
 * — the `src/tui/chat/ChatRow.tsx` counterpart (issue #15 G3).
 *
 * Pure view layer: AI SDK `UIMessage` parts verbatim → glyphs, per the pane's
 * rendering contract (no normalization between the harness stream and the
 * screen — the UIMessage parts ARE the render schema). The body/summary
 * helpers are the shared framework-free `history/message-core` pair; the
 * `BodyLines` block comes from the already-ported React history pane.
 */

import { TextAttributes } from "@opentui/core"
import {
  type DynamicToolUIPart,
  type ToolUIPart,
  type UIMessage,
  getToolName,
  isReasoningUIPart,
  isTextUIPart,
  isToolUIPart,
} from "ai"
import { bodyText, toolInputSummary } from "../../tui/history/message-core"
import { useTheme } from "../context/theme"
import { BodyLines } from "../history/message-card"
import { useT } from "../i18n"

/** Transcript entries: the typed prompt echo, AI SDK UIMessages verbatim, spawn-level failures. */
export type ChatItem =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "ui"; readonly msg: UIMessage }
  | { readonly kind: "error"; readonly text: string }

type ToolPart = ToolUIPart | DynamicToolUIPart

/** Tool output body, present only once the call resolves successfully. */
function toolOutputText(part: ToolPart): string {
  return part.state === "output-available" ? bodyText(part.output) : ""
}

/** Tool failure text, present only on the error terminal state. */
function toolErrorText(part: ToolPart): string {
  return part.state === "output-error" ? part.errorText : ""
}

/**
 * One AI SDK UIMessage part → glyphs: text = prose, reasoning = ✱ thinking,
 * tool (static or dynamic) = ⏺ rows colored by the part's state machine
 * (input-streaming/-available → output-available | output-error).
 */
function UiPartView(props: { part: UIMessage["parts"][number]; expanded: boolean }) {
  const { theme } = useTheme()
  const t = useT()
  const part = props.part
  if (isTextUIPart(part)) {
    return (
      <text fg={theme.text} wrapMode="word">
        {part.text}
      </text>
    )
  }
  if (isReasoningUIPart(part)) {
    return (
      <box flexDirection="column">
        <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
          {`✱ ${t("chat.thinking")}…`}
        </text>
        {props.expanded && part.text.trim() ? <BodyLines text={part.text} /> : null}
      </box>
    )
  }
  if (isToolUIPart(part)) {
    const summary = toolInputSummary(part.input)
    const errText = toolErrorText(part)
    const outText = toolOutputText(part)
    return (
      <box flexDirection="column">
        <box flexDirection="row" gap={1}>
          {/* Bullet + name never shrink; the one-line summary clips at the
              pane edge instead of crushing them (long Bash commands). */}
          <text
            fg={
              part.state === "output-error"
                ? theme.error
                : part.state === "output-available"
                  ? theme.success
                  : theme.textMuted
            }
            wrapMode="none"
            flexShrink={0}
          >
            ⏺
          </text>
          <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
            {getToolName(part)}
          </text>
          {summary ? (
            <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
              {summary}
            </text>
          ) : null}
        </box>
        {errText ? <BodyLines text={errText} error /> : null}
        {props.expanded && outText ? <BodyLines text={outText} /> : null}
      </box>
    )
  }
  return null
}

function partKey(part: UIMessage["parts"][number], index: number): string {
  if (isToolUIPart(part)) return `tool:${part.toolCallId}`
  return `${part.type}:${index}`
}

/** One transcript row. */
export function ChatRow(props: { item: ChatItem; expanded: boolean }) {
  const { theme } = useTheme()
  const t = useT()
  const item = props.item
  if (item.kind === "prompt") {
    return (
      <box
        flexDirection="row"
        gap={1}
        paddingLeft={1}
        paddingRight={1}
        marginTop={1}
        marginBottom={1}
        backgroundColor={theme.backgroundElement}
      >
        <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
          ❯
        </text>
        <text fg={theme.text} wrapMode="word" flexGrow={1}>
          {item.text}
        </text>
      </box>
    )
  }
  if (item.kind === "error") {
    return (
      <text fg={theme.error} wrapMode="word">
        {`${t("chat.errorPrefix")}: ${item.text}`}
      </text>
    )
  }
  // AI SDK path: the UIMessage snapshot grows in place while streaming, so
  // rendering its parts verbatim IS the live view — no preview row needed.
  return (
    <box flexDirection="column" marginBottom={item.msg.parts.some((p) => p.type === "text") ? 1 : 0}>
      {item.msg.parts.map((part, i) => (
        <UiPartView key={partKey(part, i)} part={part} expanded={props.expanded} />
      ))}
    </box>
  )
}
