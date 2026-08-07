import type { TimelineItem } from "./timeline.ts"

export type TraceFieldTone = "code" | "prose" | "value"

export interface ReadableTraceField {
  readonly label: string
  readonly text: string
  readonly tone: TraceFieldTone
}

const LABELS: Record<string, string> = {
  cmd: "Command",
  command: "Command",
  cwd: "Working directory",
  workdir: "Working directory",
  file_path: "File",
  max_output_tokens: "Output limit",
  yield_time_ms: "Wait",
  wall_time_seconds: "Duration",
  exit_code: "Exit code",
  stdout: "Standard output",
  stderr: "Standard error",
  output: "Output",
  error: "Error",
  path: "Path",
  pattern: "Pattern",
  query: "Query",
  prompt: "Prompt",
  description: "Description",
  content: "Content",
  message: "Message",
  text: "Text",
}

const CODE_FIELDS = new Set([
  "cmd",
  "command",
  "stdout",
  "stderr",
  "output",
  "error",
  "patch",
  "diff",
])
const PROSE_FIELDS = new Set([
  "prompt",
  "description",
  "content",
  "message",
  "text",
  "reasoning",
])
const FIELD_PRIORITY = [
  "cmd",
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "prompt",
  "description",
  "output",
  "stdout",
  "stderr",
  "error",
]
const QUOTE_LIMIT = 16_000

function humanizeKey(key: string): string {
  const known = LABELS[key]
  if (known) return known
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
  return words ? `${words[0]?.toUpperCase() ?? ""}${words.slice(1)}` : "Value"
}

function formatValue(key: string, value: unknown): string {
  if (value === null) return "None"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number") {
    if (key.endsWith("_ms"))
      return value >= 1_000 ? `${value / 1_000} s` : `${value} ms`
    if (key.endsWith("_seconds")) return `${value} s`
    if (key === "max_output_tokens")
      return `${value.toLocaleString("en-US")} tokens`
    if (key === "exit_code")
      return value === 0 ? "0 · success" : `${value} · failed`
    return value.toLocaleString("en-US")
  }
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function toneFor(key: string, value: unknown): TraceFieldTone {
  if (CODE_FIELDS.has(key)) return "code"
  if (PROSE_FIELDS.has(key)) return "prose"
  if (typeof value === "object" && value !== null) return "code"
  return "value"
}

function parseStructured(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (
    !(
      trimmed.startsWith("{") ||
      trimmed.startsWith("[") ||
      trimmed.startsWith('"')
    )
  )
    return undefined
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed === "string") {
      const nested = parsed.trim()
      if (nested.startsWith("{") || nested.startsWith("[")) {
        try {
          return JSON.parse(nested)
        } catch {
          return undefined
        }
      }
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

function orderedEntries(
  record: Record<string, unknown>,
): Array<[string, unknown]> {
  const rank = (key: string): number => {
    const index = FIELD_PRIORITY.indexOf(key)
    return index < 0 ? FIELD_PRIORITY.length : index
  }
  return Object.entries(record).sort(([a], [b]) => rank(a) - rank(b))
}

/** Generic presentation parser. Engine adapters still own the trace values;
 * this only turns JSON-shaped strings into labels a person can scan. */
export function readableTraceContent(
  label: string,
  text: string,
): readonly ReadableTraceField[] {
  const parsed = parseStructured(text)
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const fields = orderedEntries(parsed as Record<string, unknown>).map(
      ([key, value]) => ({
        label: humanizeKey(key),
        text: formatValue(key, value),
        tone: toneFor(key, value),
      }),
    )
    if (fields.length > 0) return fields
  }
  if (Array.isArray(parsed)) {
    return [{ label, text: formatValue("items", parsed), tone: "code" }]
  }
  return [{ label, text: text || "(empty)", tone: "prose" }]
}

function itemKindLabel(item: TimelineItem): string {
  if (item.kind === "commentary") return "Commentary"
  if (item.kind === "reasoning") return "Reasoning"
  if (item.kind === "change") return "Change"
  if (item.kind === "answer") return "Result"
  if (item.kind === "subagent") return "Subagent"
  if (item.kind === "compaction") return "Compaction"
  return "Tool"
}

function appendContent(lines: string[], label: string, text: string): void {
  if (!text) return
  lines.push(label)
  for (const field of readableTraceContent(label, text)) {
    if (field.label !== label) lines.push(`${field.label}:`)
    lines.push(field.text, "")
  }
}

/** Self-contained text pasted into the native engine composer. It references
 * one trace node but never sends the next turn automatically. */
export function quoteTraceItem(item: TimelineItem): string {
  const close = "[/Quoted Agent Trace block]"
  const lines = [
    `[Quoted Agent Trace block · ${itemKindLabel(item)} · ${item.title}]`,
    "",
  ]
  appendContent(lines, item.kind === "change" ? "Patch" : "Input", item.detail)
  if (item.resultDetail) appendContent(lines, "Result", item.resultDetail)
  lines.push(close)
  const full = lines.join("\n").replace(/\n{3,}/g, "\n\n")
  if (full.length <= QUOTE_LIMIT) return full
  const suffix = `\n\n[quoted block truncated]\n${close}`
  return `${full.slice(0, QUOTE_LIMIT - suffix.length).trimEnd()}${suffix}`
}
