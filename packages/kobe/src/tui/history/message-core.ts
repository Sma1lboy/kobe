/**
 * Framework-free transcript helpers shared by the Solid and React history
 * renderers. Keep renderer imports out of this file so vitest can pin the
 * formatting contracts without loading @opentui.
 */

import type { ContentBlock } from "@/types/content"
import type { Message } from "@/types/engine"

/** One-line cap for a tool call's input summary. */
const SUMMARY_MAX = 120

export type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>

/** Relative age of an ISO timestamp ("3m", "2h", "4d"), or "" when unparseable. */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ""
  const secs = Math.max(0, Math.floor((nowMs - ms) / 1000))
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * One-line label for a tool call. Picks the most meaningful string field by
 * priority; else compact JSON, truncated.
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
    const raw = JSON.stringify(value, null, 2)
    return raw === undefined ? String(value) : raw
  } catch {
    return String(value)
  }
}

/** Index tool_result blocks by their callId so a tool_call can show its result. */
export function resultsByCallId(messages: readonly Message[]): Map<string, ToolResultBlock> {
  const map = new Map<string, ToolResultBlock>()
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type === "tool_result") map.set(b.callId, b)
    }
  }
  return map
}
