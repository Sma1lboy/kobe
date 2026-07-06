import type { ContentBlock } from "./history.ts"

type ToolCall = Extract<ContentBlock, { type: "tool_call" }>

const MAX = 90

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

export function outputText(output: unknown): string {
  if (typeof output === "string") return output
  if (output == null) return ""
  try {
    return JSON.stringify(output, null, 2)
  } catch {
    return String(output)
  }
}
