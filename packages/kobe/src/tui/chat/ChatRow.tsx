/**
 * Transcript row rendering for the native chat pane (`ChatPane.tsx`).
 *
 * Pure view layer: AI SDK `UIMessage` parts verbatim → glyphs, per the pane's
 * rendering contract (no normalization between the harness stream and the
 * screen — the UIMessage parts ARE the render schema). Split out of
 * ChatPane.tsx for the ~500-line file cap.
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
import { For, Match, Show, Switch } from "solid-js"
import { useTheme } from "../context/theme"
import { BodyLines, bodyText, toolInputSummary } from "../history/host"
import { t } from "../i18n"

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
  const part = props.part
  return (
    <Switch>
      <Match when={isTextUIPart(part) && part}>
        {(text) => (
          <text fg={theme.text} wrapMode="word">
            {text().text}
          </text>
        )}
      </Match>
      <Match when={isReasoningUIPart(part) && part}>
        {(reasoning) => (
          <box flexDirection="column">
            <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
              {`✱ ${t("chat.thinking")}…`}
            </text>
            <Show when={props.expanded && reasoning().text.trim()}>
              <BodyLines text={reasoning().text} />
            </Show>
          </box>
        )}
      </Match>
      <Match when={isToolUIPart(part) && part}>
        {(tool) => (
          <box flexDirection="column">
            <box flexDirection="row" gap={1}>
              {/* Bullet + name never shrink; the one-line summary clips at the
                  pane edge instead of crushing them (long Bash commands). */}
              <text
                fg={
                  tool().state === "output-error"
                    ? theme.error
                    : tool().state === "output-available"
                      ? theme.success
                      : theme.textMuted
                }
                wrapMode="none"
                flexShrink={0}
              >
                ⏺
              </text>
              <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
                {getToolName(tool())}
              </text>
              <Show when={toolInputSummary(tool().input)}>
                <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
                  {toolInputSummary(tool().input)}
                </text>
              </Show>
            </box>
            <Show when={toolErrorText(tool())}>{(err) => <BodyLines text={err()} error />}</Show>
            <Show when={props.expanded && toolOutputText(tool())}>{(out) => <BodyLines text={out()} />}</Show>
          </box>
        )}
      </Match>
    </Switch>
  )
}

/** One transcript row. */
export function ChatRow(props: { item: ChatItem; expanded: boolean }) {
  const { theme } = useTheme()
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
      <For each={item.msg.parts}>{(part) => <UiPartView part={part} expanded={props.expanded} />}</For>
    </box>
  )
}
