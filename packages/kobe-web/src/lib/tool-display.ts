/**
 * Tool-call display helpers for the chat transcript — turn an engine tool call
 * + result into the compact text the transcript shows. Pure; shared out of
 * ChatTranscript so the labeling is unit-testable.
 */

import type { ContentBlock } from "./history.ts"

type ToolCall = Extract<ContentBlock, { type: "tool_call" }>

const MAX = 90

/**
 * One-line label for a tool call. Picks the most meaningful string field by a
 * deliberate priority (command → file_path → pattern → url → description →
 * prompt → query) so e.g. a Bash call reads as its command and a Read call as
 * its path, instead of a raw JSON blob. Falls back to compact JSON, and
 * truncates anything past MAX with an ellipsis.
 */
export function toolInputSummary(call: ToolCall): string {
  const input = call.input as Record<string, unknown> | null | undefined
  if (input && typeof input === "object") {
    const pick = (key: string): string | null =>
      typeof input[key] === "string" ? (input[key] as string) : null
    const candidate =
      pick("command") ??
      pick("file_path") ??
      pick("pattern") ??
      pick("url") ??
      pick("description") ??
      pick("prompt") ??
      pick("query")
    if (candidate)
      return candidate.length > MAX
        ? `${candidate.slice(0, MAX - 1)}…`
        : candidate
  }
  try {
    const raw = JSON.stringify(call.input)
    if (!raw || raw === "{}" || raw === "null") return ""
    return raw.length > MAX ? `${raw.slice(0, MAX - 1)}…` : raw
  } catch {
    return ""
  }
}

/** Render a tool result payload as display text: a string passes through, null
 *  is empty, anything else is pretty-printed JSON (String() as a last resort). */
export function outputText(output: unknown): string {
  if (typeof output === "string") return output
  if (output == null) return ""
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}
