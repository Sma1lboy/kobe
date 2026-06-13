/**
 * Transcript → Markdown. Serializes the messages a user currently sees (the
 * search-filtered, hide-tools-aware list) into a clean Markdown document they
 * can paste into a doc, an issue, or a chat to a friend — the "take this
 * session with you" path. Pure + React-free so it's unit-testable; the
 * transcript header's "copy as markdown" button feeds it `shown` + the live
 * results map.
 *
 * Mirrors the on-screen render decisions so the export matches the view:
 *  - tool calls are dropped when hideTools is on (export what you see);
 *  - tool_result blocks never appear standalone — a call's output is attached
 *    to its `**↳ name**` line, resolved through the full results map (Codex
 *    emits results on a different message than the call, so the map spans the
 *    whole transcript, not just the shown slice);
 *  - empty / whitespace text + thinking blocks are skipped, same as MessageRow.
 */

import type { ContentBlock, HistoryMessage } from "./history.ts"
import { outputText, toolInputSummary } from "./tool-display.ts"

type ToolResult = Extract<ContentBlock, { type: "tool_result" }>

/** How much tool output to inline before truncating — matches the transcript's
 *  default collapsed preview so a copied tool step reads like the closed UI. */
const OUTPUT_LIMIT = 600

export interface TranscriptMarkdownMeta {
  /** Task title / branch — the document heading. */
  title: string
  /** Engine vendor label (e.g. "claude", "codex"). */
  vendor: string
  /** Total messages in the session, before the search filter. */
  total: number
}

const ROLE_LABEL: Record<HistoryMessage["role"], string> = {
  user: "You",
  assistant: "Assistant",
  system: "System",
}

/** Indent every line of `text` with `> ` so multi-line content stays inside one
 *  Markdown blockquote (a single `> ` only quotes the first line). */
function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n")
}

/** Render one tool call as a `**↳ name** \`summary\`` line plus, when the call
 *  has a non-empty result, a fenced block of its (truncated) output. */
function toolMarkdown(
  call: Extract<ContentBlock, { type: "tool_call" }>,
  results: ReadonlyMap<string, ToolResult>,
): string {
  const summary = toolInputSummary(call)
  const header = summary
    ? `**↳ ${call.name}** \`${summary}\``
    : `**↳ ${call.name}**`
  const result = results.get(call.callId)
  const body = result ? outputText(result.output).trimEnd() : ""
  if (!body) return header
  const clipped =
    body.length > OUTPUT_LIMIT
      ? `${body.slice(0, OUTPUT_LIMIT)}\n… (truncated)`
      : body
  // Guard against the rare output containing a ``` fence that would break out.
  const fence = clipped.includes("```") ? "````" : "```"
  const tag = result?.isError ? " error" : ""
  return `${header}\n\n${fence}${tag ? `text${tag}` : ""}\n${clipped}\n${fence}`
}

/** Serialize one message into its Markdown chunks (role header + each rendered
 *  block), or null when the message would render nothing on screen. */
/**
 * One message as Markdown (`### Role` + its blocks), or null when it renders
 * nothing (empty prose, or tool-only while tools are hidden). Exported so the
 * transcript can offer a per-message copy that matches the full-export format.
 */
export function messageMarkdown(
  message: HistoryMessage,
  results: ReadonlyMap<string, ToolResult>,
  hideTools: boolean,
): string | null {
  const parts: string[] = []
  for (const block of message.blocks) {
    if (block.type === "text" || block.type === "thinking") {
      const text = block.text.trim()
      if (!text) continue
      parts.push(block.type === "thinking" ? blockquote(`💭 ${text}`) : text)
    } else if (block.type === "tool_call") {
      if (hideTools) continue
      parts.push(toolMarkdown(block, results))
    }
    // tool_result: attached to its call above, never standalone.
  }
  if (parts.length === 0) return null
  return `### ${ROLE_LABEL[message.role]}\n\n${parts.join("\n\n")}`
}

/**
 * Build the full Markdown document for a (filtered) transcript. `messages` is
 * the shown slice; `results` must span the whole session so a tool call whose
 * result lives on a filtered-out message still resolves its output.
 */
export function transcriptToMarkdown(
  messages: readonly HistoryMessage[],
  results: ReadonlyMap<string, ToolResult>,
  hideTools: boolean,
  meta: TranscriptMarkdownMeta,
): string {
  const shownCount = messages.reduce(
    (n, m) => (messageMarkdown(m, results, hideTools) ? n + 1 : n),
    0,
  )
  const notes: string[] = [`\`${meta.vendor}\``]
  notes.push(
    shownCount === meta.total
      ? `${meta.total} messages`
      : `${shownCount} of ${meta.total} messages`,
  )
  if (hideTools) notes.push("tools hidden")

  const head = `# ${meta.title} — transcript\n\n${notes.join(" · ")}`
  const body = messages
    .map((m) => messageMarkdown(m, results, hideTools))
    .filter((chunk): chunk is string => chunk !== null)
  return `${[head, ...body].join("\n\n---\n\n")}\n`
}
