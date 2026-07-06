/** @jsxImportSource @opentui/react */
/**
 * React transcript row rendering for the history pane. The visual grammar
 * mirrors `src/tui/history/message-card.tsx`; pure formatting helpers live in
 * `src/tui/history/message-core.ts` so Solid and React cannot drift.
 */

import type { ContentBlock } from "@/types/content"
import type { Message } from "@/types/engine"
import { TextAttributes } from "@opentui/core"
import { useMemo } from "react"
import { type ToolResultBlock, bodyText, relativeTime, toolInputSummary } from "../../tui/history/message-core"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"

export { bodyText, toolInputSummary } from "../../tui/history/message-core"

function lineKey(line: string, index: number): string {
  return `${index}:${line}`
}

function blockKey(block: ContentBlock, index: number): string {
  switch (block.type) {
    case "tool_call":
    case "tool_result":
      return `${block.type}:${block.callId}`
    case "text":
      return `text:${block.text}:${index}`
    case "thinking":
      return `thinking:${block.text}:${index}`
  }
}

/** A tool-output / thinking body, one `<text>` per line so +/- diff lines tint. */
export function BodyLines(props: { text: string; error?: boolean }) {
  const { theme } = useTheme()
  const lines = useMemo(() => props.text.replace(/\s+$/, "").split("\n"), [props.text])
  const lineColor = (line: string) => {
    if (props.error) return theme.error
    if (line.startsWith("+") && !line.startsWith("+++")) return theme.success
    if (line.startsWith("-") && !line.startsWith("---")) return theme.error
    return theme.textMuted
  }
  return (
    <box flexDirection="column" paddingLeft={2} marginLeft={2} backgroundColor={theme.backgroundElement}>
      {lines.map((line, i) => (
        <text key={lineKey(line, i)} fg={lineColor(line)} wrapMode="word">
          {line || " "}
        </text>
      ))}
    </box>
  )
}

function BlockView(props: {
  block: ContentBlock
  result?: ToolResultBlock
  expanded: boolean
}) {
  const { theme } = useTheme()
  const t = useT()
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
          {props.expanded && block.text.trim() ? <BodyLines text={block.text} /> : null}
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
            {summary ? (
              <text fg={theme.textMuted} wrapMode="none">
                {summary}
              </text>
            ) : null}
          </box>
          {props.expanded && body.trim() ? <BodyLines text={body} error={props.result?.isError} /> : null}
        </box>
      )
    }
    case "tool_result":
      return null
  }
}

function roleLabel(role: Message["role"], t: ReturnType<typeof useT>): string {
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
  const t = useT()
  const isUser = props.msg.role === "user"
  const stamp = relativeTime(props.msg.timestamp)
  const userText = useMemo(
    () =>
      isUser
        ? props.msg.blocks
            .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text" && b.text.trim().length > 0)
            .map((b) => b.text)
            .join("\n")
        : "",
    [isUser, props.msg.blocks],
  )
  const otherBlocks = useMemo(
    () => (isUser ? props.msg.blocks.filter((b) => b.type !== "text") : props.msg.blocks),
    [isUser, props.msg.blocks],
  )

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingBottom={1} gap={0}>
      {isUser && userText ? (
        <box flexDirection="row" gap={1} paddingLeft={1} paddingRight={1} backgroundColor={theme.backgroundElement}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">
            ❯
          </text>
          <text fg={theme.text} wrapMode="word" flexGrow={1}>
            {userText}
          </text>
          {stamp ? (
            <text fg={theme.textMuted} wrapMode="none">
              {stamp}
            </text>
          ) : null}
        </box>
      ) : null}
      {!isUser ? (
        <text fg={theme.textMuted} attributes={TextAttributes.BOLD} wrapMode="none">
          {roleLabel(props.msg.role, t)}
        </text>
      ) : null}
      {otherBlocks.map((block, i) => (
        <BlockView
          key={blockKey(block, i)}
          block={block}
          result={block.type === "tool_call" ? props.results.get(block.callId) : undefined}
          expanded={props.expanded}
        />
      ))}
    </box>
  )
}
