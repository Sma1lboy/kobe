/**
 * Engine-neutral mindset map derived from normalized EngineHistory. Vendor
 * adapters own transcript parsing and visible assistant phases; this module
 * groups the common vocabulary into user turn → visible thought → tool branch.
 */

import type { ContentBlock, HistoryMessage } from "./history.ts"
import { toolInputSummary } from "./tool-display.ts"

export type TimelineStatus = "running" | "success" | "error" | "blocked"
export type TimelineItemKind =
  | "thought"
  | "reasoning"
  | "tool"
  | "change"
  | "response"

export interface TimelineItem {
  id: string
  /** One-level causal edge: tool calls point at the visible thought/reasoning
   * node that immediately preceded them. Root nodes keep this null. */
  parentId: string | null
  kind: TimelineItemKind
  status: TimelineStatus
  title: string
  summary: string
  /** Full visible text or tool input for the detail drawer. */
  detail: string
  /** Matched tool result output; null for non-tools or a pending call. */
  resultDetail: string | null
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

const DETAIL_LIMIT = 100_000

function detailText(value: unknown): string {
  let text: string
  if (typeof value === "string") text = value
  else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  if (text.length <= DETAIL_LIMIT) return text
  return `${text.slice(0, DETAIL_LIMIT)}\n\n… truncated for display (${text.length - DETAIL_LIMIT} more characters)`
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
  parentId: string | null,
): TimelineItem {
  const startedAt = timestampMs(message.timestamp)
  const isError = result?.result.isError === true
  return {
    id: `tool:${block.callId}`,
    parentId,
    kind: CHANGE_TOOL.test(block.name) ? "change" : "tool",
    status: isError ? "error" : result ? "success" : "running",
    title: block.name,
    summary: toolInputSummary(block),
    detail: detailText(block.input),
    resultDetail: result ? detailText(result.result.output) : null,
    startedAt,
    endedAt: result?.at ?? null,
  }
}

function messageItems(
  message: HistoryMessage,
  messageIndex: number,
  results: ReadonlyMap<string, ResultFact>,
  initialParentId: string | null,
): { items: TimelineItem[]; parentId: string | null } {
  const at = timestampMs(message.timestamp)
  const out: TimelineItem[] = []
  let parentId = initialParentId
  message.blocks.forEach((block, blockIndex) => {
    const id = `${message.sessionId}:${messageIndex}:${blockIndex}`
    if (block.type === "tool_call") {
      out.push(toolItem(block, message, results.get(block.callId), parentId))
    } else if (block.type === "thinking" && block.text.trim()) {
      const item: TimelineItem = {
        id: `reasoning:${id}`,
        parentId: null,
        kind: "reasoning",
        status: "success",
        title: compact(block.text, 140),
        summary: "",
        detail: block.text.trim(),
        resultDetail: null,
        startedAt: at,
        endedAt: at,
      }
      out.push(item)
      parentId = item.id
    } else if (
      block.type === "text" &&
      message.role !== "user" &&
      block.text.trim()
    ) {
      const hasToolAfter = message.blocks
        .slice(blockIndex + 1)
        .some((candidate) => candidate.type === "tool_call")
      const isThought =
        message.phase === "commentary" ||
        (message.phase === undefined && hasToolAfter)
      const item: TimelineItem = {
        id: `${isThought ? "thought" : "response"}:${id}`,
        parentId: null,
        kind: isThought ? "thought" : "response",
        status: "success",
        title: compact(block.text, 140),
        summary: "",
        detail: block.text.trim(),
        resultDetail: null,
        startedAt: at,
        endedAt: at,
      }
      out.push(item)
      parentId = isThought ? item.id : null
    }
  })
  return { items: out, parentId }
}

function rollUpBranches(items: readonly TimelineItem[]): TimelineItem[] {
  const children = new Map<string, TimelineItem[]>()
  for (const item of items) {
    if (!item.parentId) continue
    const branch = children.get(item.parentId) ?? []
    branch.push(item)
    children.set(item.parentId, branch)
  }
  return items.map((item) => {
    const branch = children.get(item.id)
    if (!branch || branch.length === 0) return item
    const status = turnStatus(branch)
    const endedAt = Math.max(
      item.endedAt ?? item.startedAt,
      ...branch.map((child) => child.endedAt ?? child.startedAt),
    )
    return { ...item, status, endedAt }
  })
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
  let activeParentId: string | null = null

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
      activeParentId = null
      return
    }

    const next = messageItems(message, messageIndex, results, activeParentId)
    const items = next.items
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
    activeParentId = next.parentId
    current.endedAt = Math.max(
      current.endedAt ?? current.startedAt,
      ...items.map((item) => item.endedAt ?? item.startedAt),
    )
    current.status = turnStatus(current.items)
  })

  for (const turn of turns) turn.items = rollUpBranches(turn.items)

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
