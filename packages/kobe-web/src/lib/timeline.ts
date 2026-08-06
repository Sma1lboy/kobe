/**
 * Engine-neutral execution timeline derived from normalized EngineHistory.
 * Vendor adapters own transcript parsing; this module only groups the common
 * Message/ContentBlock vocabulary into two levels: user turn → execution item.
 */

import type { ContentBlock, HistoryMessage } from "./history.ts"
import { toolInputSummary } from "./tool-display.ts"

export type TimelineStatus = "running" | "success" | "error" | "blocked"
export type TimelineItemKind = "reasoning" | "tool" | "change" | "response"

export interface TimelineItem {
  id: string
  kind: TimelineItemKind
  status: TimelineStatus
  title: string
  summary: string
  startedAt: number
  endedAt: number | null
}

export interface TimelineTurn {
  id: string
  title: string
  startedAt: number
  endedAt: number | null
  status: TimelineStatus
  items: TimelineItem[]
}

export interface TimelineModel {
  sessionId: string | null
  turns: TimelineTurn[]
}

type ToolCall = Extract<ContentBlock, { type: "tool_call" }>
type ToolResult = Extract<ContentBlock, { type: "tool_result" }>

interface ResultFact {
  result: ToolResult
  at: number
}

const CHANGE_TOOL = /apply.?patch|edit|write|notebook|file.?pen/i

function timestampMs(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function userPrompt(message: HistoryMessage): string {
  if (message.role !== "user") return ""
  return message.blocks
    .filter(
      (block): block is Extract<ContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
}

function compact(value: string, max = 88): string {
  const oneLine = value.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function resultsByCallId(
  messages: readonly HistoryMessage[],
): Map<string, ResultFact> {
  const results = new Map<string, ResultFact>()
  for (const message of messages) {
    const at = timestampMs(message.timestamp)
    for (const block of message.blocks) {
      if (block.type === "tool_result")
        results.set(block.callId, { result: block, at })
    }
  }
  return results
}

function toolItem(
  block: ToolCall,
  message: HistoryMessage,
  result: ResultFact | undefined,
): TimelineItem {
  const startedAt = timestampMs(message.timestamp)
  const isError = result?.result.isError === true
  return {
    id: `tool:${block.callId}`,
    kind: CHANGE_TOOL.test(block.name) ? "change" : "tool",
    status: isError ? "error" : result ? "success" : "running",
    title: block.name,
    summary: toolInputSummary(block),
    startedAt,
    endedAt: result?.at ?? null,
  }
}

function messageItems(
  message: HistoryMessage,
  messageIndex: number,
  results: ReadonlyMap<string, ResultFact>,
): TimelineItem[] {
  const at = timestampMs(message.timestamp)
  const out: TimelineItem[] = []
  message.blocks.forEach((block, blockIndex) => {
    const id = `${message.sessionId}:${messageIndex}:${blockIndex}`
    if (block.type === "tool_call") {
      out.push(toolItem(block, message, results.get(block.callId)))
    } else if (block.type === "thinking" && block.text.trim()) {
      out.push({
        id: `reasoning:${id}`,
        kind: "reasoning",
        status: "success",
        title: "Reasoning",
        summary: compact(block.text),
        startedAt: at,
        endedAt: at,
      })
    } else if (
      block.type === "text" &&
      message.role !== "user" &&
      block.text.trim()
    ) {
      out.push({
        id: `response:${id}`,
        kind: "response",
        status: "success",
        title: message.role === "system" ? "System" : "Response",
        summary: compact(block.text),
        startedAt: at,
        endedAt: at,
      })
    }
  })
  return out
}

function turnStatus(items: readonly TimelineItem[]): TimelineStatus {
  if (items.some((item) => item.status === "error")) return "error"
  if (items.some((item) => item.status === "running")) return "running"
  return "success"
}

/** Build stable turn/item nodes. A role:user tool_result does not start a new
 * turn; only visible user text does. Items before the first prompt are grouped
 * into a neutral session-activity turn instead of being dropped. */
export function buildTimeline(
  messages: readonly HistoryMessage[],
): TimelineModel {
  const results = resultsByCallId(messages)
  const turns: TimelineTurn[] = []
  let current: TimelineTurn | null = null

  messages.forEach((message, messageIndex) => {
    const prompt = userPrompt(message)
    const at = timestampMs(message.timestamp)
    if (prompt) {
      if (current && current.endedAt === null) current.endedAt = at
      current = {
        id: `turn:${message.sessionId}:${messageIndex}`,
        title: compact(prompt),
        startedAt: at,
        endedAt: null,
        status: "success",
        items: [],
      }
      turns.push(current)
      return
    }

    const items = messageItems(message, messageIndex, results)
    if (items.length === 0) return
    if (!current) {
      current = {
        id: `turn:${message.sessionId}:session`,
        title: "Session activity",
        startedAt: at,
        endedAt: null,
        status: "success",
        items: [],
      }
      turns.push(current)
    }
    current.items.push(...items)
    current.endedAt = Math.max(
      current.endedAt ?? current.startedAt,
      ...items.map((item) => item.endedAt ?? item.startedAt),
    )
    current.status = turnStatus(current.items)
  })

  return { sessionId: messages.at(-1)?.sessionId ?? null, turns }
}

/** Merge daemon liveness into the latest stable history turn. When the prompt
 * has not landed in history yet, synthesize one live root so the pane reacts
 * immediately instead of waiting for transcript persistence. */
export function withLiveState(
  model: TimelineModel,
  state: string | undefined,
  at: number,
): TimelineModel {
  const status: TimelineStatus | null =
    state === "running"
      ? "running"
      : state === "permission_needed"
        ? "blocked"
        : state === "error" || state === "rate_limited"
          ? "error"
          : null
  if (!status) return model

  if (model.turns.length === 0) {
    return {
      ...model,
      turns: [
        {
          id: `turn:live:${model.sessionId ?? "pending"}`,
          title: status === "blocked" ? "Waiting for input" : "Current turn",
          startedAt: at,
          endedAt: null,
          status,
          items: [],
        },
      ],
    }
  }

  const turns = model.turns.slice()
  const last = turns[turns.length - 1]
  if (!last) return model
  if (last.endedAt !== null && at > last.endedAt) {
    turns.push({
      id: `turn:live:${model.sessionId ?? "pending"}:${at}`,
      title: status === "blocked" ? "Waiting for input" : "Current turn",
      startedAt: at,
      endedAt: null,
      status,
      items: [],
    })
    return { ...model, turns }
  }
  turns[turns.length - 1] = { ...last, status, endedAt: null }
  return { ...model, turns }
}

export function durationMs(
  startedAt: number,
  endedAt: number | null,
  now: number,
): number {
  return Math.max(0, (endedAt ?? now) - startedAt)
}
