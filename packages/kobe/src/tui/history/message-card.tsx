/**
 * Transcript row rendering for the history pane — extracted from `host.tsx`
 * (500-line cap). One `MessageCard` per message: user turns are tinted cards
 * with a `❯` glyph + relative-time chip, assistant text is plain, tool calls
 * are a colored `⏺` status glyph + bold name + dim summary, and the expanded
 * state reveals tool-output / thinking bodies. `BodyLines`, `bodyText` and
 * `toolInputSummary` are shared with the chat surface (`chat/ChatRow.tsx`,
 * via the `host.tsx` re-export) so both transcripts read identically.
 */

import type { ContentBlock } from "@/types/content"
import type { Message } from "@/types/engine"
import { TextAttributes } from "@opentui/core"
import { For, Show, createMemo } from "solid-js"
import { useTheme } from "../context/theme"
import { t } from "../i18n"

/** One-line cap for a tool call's input summary. */
const SUMMARY_MAX = 120

/** Relative age of an ISO timestamp ("3m", "2h", "4d"), or "" when unparseable. */
function relativeTime(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ""
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * One-line label for a tool call — ported from the web `tool-display.ts` so both
 * surfaces read identically (don't reinvent). Picks the most meaningful string field
 * by priority (command → file_path → pattern → url → description → prompt → query), so
 * a Bash call reads as its command and a Read as its path; else compact JSON, truncated.
 */
export function toolInputSummary(input: unknown): string {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>
    const pick = (key: string): string | null => (typeof obj[key] === "string" ? (obj[key] as string) : null)
    const candidate =
      pick("command") ??
      pick("file_path") ??
      pick("pattern") ??
      pick("url") ??
      pick("description") ??
      pick("prompt") ??
      pick("query")
    if (candidate) return candidate.length > SUMMARY_MAX ? `${candidate.slice(0, SUMMARY_MAX - 1)}…` : candidate
  }
  try {
    const raw = JSON.stringify(input)
    if (!raw || raw === "{}" || raw === "null") return ""
    return raw.length > SUMMARY_MAX ? `${raw.slice(0, SUMMARY_MAX - 1)}…` : raw
  } catch {
    return ""
  }
}

/** Full multi-line stringification of a tool result, for the expanded body. */
export function bodyText(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Index tool_result blocks by their callId so a tool_call can show its result. */
export function resultsByCallId(
  messages: readonly Message[],
): Map<string, Extract<ContentBlock, { type: "tool_result" }>> {
  const map = new Map<string, Extract<ContentBlock, { type: "tool_result" }>>()
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "tool_result") map.set(b.callId, b)
    }
  }
  return map
}

/** A tool-output / thinking body, one `<text>` per line so +/- diff lines tint. */
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
  result?: Extract<ContentBlock, { type: "tool_result" }>
  expanded: boolean
}) {
  const { theme } = useTheme()
  const block = props.block
  switch (block.type) {
    case "text":
      // user-text is rendered as a card by MessageCard; this path is assistant/system.
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
      // Attached to its tool_call above — never rendered standalone.
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
  results: Map<string, Extract<ContentBlock, { type: "tool_result" }>>
  expanded: boolean
}) {
  const { theme } = useTheme()
  const isUser = () => props.msg.role === "user"
  const stamp = () => relativeTime(props.msg.timestamp)
  // user text blocks → a tinted card with a ❯ glyph + time chip; everything
  // else (assistant/system text, tools, thinking) renders flush below.
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
