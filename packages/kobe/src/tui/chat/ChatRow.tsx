/**
 * Transcript row rendering for the native chat pane (`ChatPane.tsx`).
 *
 * Pure view layer: SDK stream-json messages verbatim → glyphs, per the
 * pane's rendering contract (no normalization between the wire and the
 * screen). Split out of ChatPane.tsx for the ~500-line file cap.
 */

import type { SdkContentBlock, SdkMessage, SdkToolResultBlock } from "@/engine/claude-code-local/headless"
import { TextAttributes } from "@opentui/core"
import type { UIMessage } from "ai"
import { For, Match, Show, Switch } from "solid-js"
import { useTheme } from "../context/theme"
import { BodyLines, bodyText, toolInputSummary } from "../history/host"
import { t } from "../i18n"

/** Transcript entries: the typed prompt echo, SDK messages verbatim (claude -p
 *  path), AI SDK UIMessages verbatim (KOBE_AISDK path), spawn-level failures. */
export type ChatItem =
  | { readonly kind: "prompt"; readonly text: string }
  | { readonly kind: "sdk"; readonly msg: SdkMessage }
  | { readonly kind: "ui"; readonly msg: UIMessage }
  | { readonly kind: "error"; readonly text: string }

/** Index tool_result blocks (SDK `user` messages) by their `tool_use_id`. */
export function sdkResultsByToolUseId(items: readonly ChatItem[]): Map<string, SdkToolResultBlock> {
  const map = new Map<string, SdkToolResultBlock>()
  for (const item of items) {
    if (item.kind !== "sdk" || item.msg.type !== "user") continue
    for (const block of item.msg.message.content) {
      if (block.type === "tool_result") map.set(block.tool_use_id, block)
    }
  }
  return map
}

/** One SDK content block of an assistant message, SDK fields straight to glyphs. */
function SdkBlockView(props: {
  block: SdkContentBlock
  result?: SdkToolResultBlock
  /** Subagent step (parent_tool_use_id set) — indented under its Agent row. */
  nested: boolean
  expanded: boolean
}) {
  const { theme } = useTheme()
  const block = props.block
  return (
    <Switch>
      <Match when={block.type === "text" && block}>
        {(b) => (
          <text fg={theme.text} wrapMode="word">
            {b().text}
          </text>
        )}
      </Match>
      <Match when={block.type === "thinking" && block}>
        {(b) => (
          <box flexDirection="column">
            <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
              {`✱ ${t("chat.thinking")}${props.expanded ? "" : "…"}`}
            </text>
            <Show when={props.expanded && b().thinking.trim()}>
              <BodyLines text={b().thinking} />
            </Show>
          </box>
        )}
      </Match>
      <Match when={block.type === "tool_use" && block}>
        {(b) => {
          const ok = () => !props.result?.is_error
          const summary = () => toolInputSummary(b().input)
          const body = () => (props.result ? bodyText(props.result.content) : "")
          return (
            <box flexDirection="column" paddingLeft={props.nested ? 2 : 0}>
              {/* Bullet + name never shrink; the one-line summary clips at the
                  pane edge instead of crushing them (long Bash commands). */}
              <box flexDirection="row" gap={1}>
                <text
                  fg={props.result ? (ok() ? theme.success : theme.error) : theme.textMuted}
                  wrapMode="none"
                  flexShrink={0}
                >
                  ⏺
                </text>
                <text fg={theme.text} attributes={TextAttributes.BOLD} wrapMode="none" flexShrink={0}>
                  {b().name}
                </text>
                <Show when={summary()}>
                  <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
                    {summary()}
                  </text>
                </Show>
              </box>
              <Show when={props.expanded && body().trim()}>
                <BodyLines text={body()} error={props.result?.is_error} />
              </Show>
            </box>
          )
        }}
      </Match>
    </Switch>
  )
}

/**
 * One AI SDK UIMessage part → glyphs, mirroring the SDK-block grammar:
 * text = prose, reasoning = ✱ thinking, tool-* / dynamic-tool = ⏺ rows
 * colored by the part's state machine (input-streaming → input-available →
 * output-available | output-error).
 */
function UiPartView(props: { part: UIMessage["parts"][number]; expanded: boolean }) {
  const { theme } = useTheme()
  const part = props.part as {
    type: string
    text?: string
    toolName?: string
    state?: string
    input?: unknown
    output?: unknown
    errorText?: string
  }
  const isTool = part.type === "dynamic-tool" || part.type.startsWith("tool-")
  return (
    <Switch>
      <Match when={part.type === "text" && part.text}>
        <text fg={theme.text} wrapMode="word">
          {part.text}
        </text>
      </Match>
      <Match when={part.type === "reasoning"}>
        <box flexDirection="column">
          <text fg={theme.textMuted} attributes={TextAttributes.ITALIC} wrapMode="none">
            {`✱ ${t("chat.thinking")}…`}
          </text>
          <Show when={props.expanded && part.text?.trim()}>
            <BodyLines text={part.text ?? ""} />
          </Show>
        </box>
      </Match>
      <Match when={isTool}>
        <box flexDirection="column">
          <box flexDirection="row" gap={1}>
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
              {part.type === "dynamic-tool" ? (part.toolName ?? "tool") : part.type.slice(5)}
            </text>
            <Show when={toolInputSummary(part.input)}>
              <text fg={theme.textMuted} wrapMode="none" flexShrink={1}>
                {toolInputSummary(part.input)}
              </text>
            </Show>
          </box>
          <Show when={part.state === "output-error" && part.errorText}>
            <BodyLines text={part.errorText ?? ""} error />
          </Show>
          <Show when={props.expanded && part.state === "output-available"}>
            <BodyLines text={bodyText(part.output)} />
          </Show>
        </box>
      </Match>
    </Switch>
  )
}

/** One transcript row. SDK `user` (tool results) and `system` rows render nothing —
 *  results attach to their tool_use row; init only feeds the resume session id. */
export function ChatRow(props: { item: ChatItem; results: Map<string, SdkToolResultBlock>; expanded: boolean }) {
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
  if (item.kind === "ui") {
    // AI SDK path: the UIMessage snapshot grows in place while streaming, so
    // rendering its parts verbatim IS the live view — no preview row needed.
    return (
      <box flexDirection="column" marginBottom={item.msg.parts.some((p) => p.type === "text") ? 1 : 0}>
        <For each={item.msg.parts}>{(part) => <UiPartView part={part} expanded={props.expanded} />}</For>
      </box>
    )
  }
  const msg = item.msg
  if (msg.type === "assistant") {
    const nested = msg.parent_tool_use_id != null
    // Subagent prose stays internal — only its tool steps surface (same rule
    // the v0.5 stream parser applied): nested rows keep tool_use blocks only.
    const blocks = msg.message.content.filter((b) => !nested || b.type === "tool_use")
    return (
      <box flexDirection="column" marginBottom={blocks.some((b) => b.type === "text") ? 1 : 0}>
        <For each={blocks}>
          {(block) => (
            <SdkBlockView
              block={block}
              result={block.type === "tool_use" ? props.results.get(block.id) : undefined}
              nested={nested}
              expanded={props.expanded}
            />
          )}
        </For>
      </box>
    )
  }
  if (msg.type === "result") {
    // Keep the turn footer terse: duration and output tokens only.
    if (msg.is_error) {
      const detail = typeof msg.result === "string" && msg.result.trim() ? msg.result.trim() : msg.subtype
      return (
        <text fg={theme.error} wrapMode="word">
          {`${t("chat.errorPrefix")}: ${detail}`}
        </text>
      )
    }
    const parts: string[] = []
    if (typeof msg.duration_ms === "number") parts.push(`${(msg.duration_ms / 1000).toFixed(1)}s`)
    if (typeof msg.usage?.output_tokens === "number") parts.push(`${msg.usage.output_tokens} tok`)
    // No marginBottom — the NEXT prompt row's marginTop owns turn spacing
    // (margins don't collapse in Yoga; both would stack to 2 blank rows).
    return (
      <Show when={parts.length > 0}>
        <text fg={theme.textMuted} wrapMode="none">
          {`· ${parts.join(" · ")}`}
        </text>
      </Show>
    )
  }
  return null
}
