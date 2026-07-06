import type { ContentBlock } from "@/types/content"
import type { Message } from "@/types/engine"
import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { type ToolResultBlock, bodyText, relativeTime, resultsByCallId, toolInputSummary } from "./message-core"

export { bodyText, resultsByCallId, toolInputSummary } from "./message-core"

export function BodyLines(props: { text: string; error?: boolean }) {
  const { theme } = useTheme()
  const lines = () => props.text.replace(/\s+$/, "").split("\n")
  const lineColor = (line: string) => {
    if (props.error) return theme.error
    if (line.startsWith("+") && !line.startsWith("+++")) return theme.success
    if (line.startsWith("-") && !line.startsWith("---")) return theme.error
    return theme.textMuted
  }
  return (
    <box flexDirection="column" paddingLeft={2} marginLeft={2} backgroundColor={theme.backgroundElement}>
      <For each={lines()}>
        {(line) => (
          <text fg={lineColor(line)} wrapMode="word">
            {line || " "}
          </text>
        )}
      </For>
    </box>
  )
}

function BlockView(props: {
  block: ContentBlock
  result?: ToolResultBlock
  expanded: boolean
}) {
  const { theme } = useTheme()
  const block = props.block
  switch (block.type) {
    case "text":
      return (
        <text fg={theme.text} wrapMode="word">
          {block.text}
        </text>
      )
    case "thinking":
      return (
        <box flexDirection="column">
          <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
            {`✱ ${t("history.thinking")}${props.expanded ? "" : "…"}`}
          </text>
          <Show when={props.expanded && block.text.trim()}>
            <BodyLines text={block.text} />
          </Show>
        </box>
      )
    case "tool_call": {
      const ok = !props.result?.isError
      const body = props.result ? bodyText(props.result.output) : ""
      const summary = toolInputSummary(block.input)
      return (
        <box flexDirection="column">
          <box flexDirection="row" gap={1}>
            <text fg={ok ? theme.success : theme.error} wrapMode="none">
              ⏺
            </text>
            <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none">
              {block.name}
            </text>
            <Show when={summary}>
              <text fg={theme.textMuted} wrapMode="none">
                {summary}
              </text>
            </Show>
          </box>
          <Show when={props.expanded && body.trim()}>
            <BodyLines text={body} error={props.result?.isError} />
          </Show>
        </box>
      )
    }
    case "tool_result":
      return null
  }
}

function roleLabel(role: Message["role"]): string {
  return role === "assistant"
    ? t("history.role.assistant")
    : role === "system"
      ? t("history.role.system")
      : t("history.role.user")
}

export function MessageCard(props: {
  msg: Message
  results: Map<string, ToolResultBlock>
  expanded: boolean
}) {
  const { theme } = useTheme()
  const isUser = () => props.msg.role === "user"
  const stamp = () => relativeTime(props.msg.timestamp)
  const userText = createMemo(() =>
    isUser()
      ? props.msg.blocks
          .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text" && b.text.trim().length > 0)
          .map((b) => b.text)
          .join("\n")
      : "",
  )
  const otherBlocks = () => (isUser() ? props.msg.blocks.filter((b) => b.type !== "text") : props.msg.blocks)
  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} gap={0}>
      <Show when={isUser() && userText()}>
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundElement}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
            ❯
          </text>
          <text fg={theme.text} wrapMode="word" flexGrow={1}>
            {userText()}
          </text>
          <Show when={stamp()}>
            <text fg={theme.textMuted} wrapMode="none">
              {stamp()}
            </text>
          </Show>
        </box>
      </Show>
      <Show when={!isUser()}>
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
          {roleLabel(props.msg.role)}
        </text>
      </Show>
      <For each={otherBlocks()}>
        {(block) => (
          <BlockView
            block={block}
            result={block.type === "tool_call" ? props.results.get(block.callId) : undefined}
            expanded={props.expanded}
          />
        )}
      </For>
    </box>
  )
}
