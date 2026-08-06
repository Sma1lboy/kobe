/** Engine-side fallback from neutral Message[] to the EngineTrace contract. */

import type { ContentBlock } from "@/types/content"
import type { EngineTrace, EngineTraceNode, EngineTraceStatus, EngineTraceTurn, Message } from "@/types/engine"

const CHANGE_TOOL = /apply.?patch|edit|write|notebook|file.?pen/i
const DETAIL_LIMIT = 100_000

function at(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function compact(value: string, max = 88): string {
  const oneLine = value.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

export function traceDetail(value: unknown): string {
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

function textBlocks(message: Message): string {
  return message.blocks
    .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n")
}

function summary(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) return compact(traceDetail(input), 72)
  const record = input as Record<string, unknown>
  for (const key of ["cmd", "command", "file_path", "path", "query", "prompt"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return compact(value, 72)
  }
  return compact(traceDetail(input), 72)
}

function status(nodes: readonly EngineTraceNode[]): EngineTraceStatus {
  if (nodes.some((node) => node.status === "error")) return "error"
  if (nodes.some((node) => node.status === "blocked")) return "blocked"
  if (nodes.some((node) => node.status === "running")) return "running"
  return "success"
}

/**
 * Compatibility producer for engines whose persisted transcript has no
 * richer turn/item ids yet. It lives behind the engine boundary, and labels
 * commentary→tool adjacency as temporal rather than source-proven.
 */
export function traceFromHistory(sessionId: string, messages: readonly Message[]): EngineTrace {
  const results = new Map<string, { block: Extract<ContentBlock, { type: "tool_result" }>; at: number }>()
  for (const message of messages) {
    for (const block of message.blocks) {
      if (block.type === "tool_result") results.set(block.callId, { block, at: at(message.timestamp) })
    }
  }

  const turns: Array<{
    id: string
    title: string
    startedAt: number
    endedAt: number | null
    nodes: EngineTraceNode[]
  }> = []
  let current: (typeof turns)[number] | undefined
  let parentId: string | null = null

  messages.forEach((message, messageIndex) => {
    const timestamp = at(message.timestamp)
    const prompt = message.role === "user" ? textBlocks(message) : ""
    if (prompt) {
      if (current && current.endedAt === null) current.endedAt = timestamp
      current = {
        id: `turn:${sessionId}:${messageIndex}`,
        title: compact(prompt),
        startedAt: timestamp,
        endedAt: null,
        nodes: [],
      }
      turns.push(current)
      parentId = null
      return
    }

    for (const [blockIndex, block] of message.blocks.entries()) {
      if (block.type === "tool_result") continue
      if (!current) {
        current = {
          id: `turn:${sessionId}:session`,
          title: "Session activity",
          startedAt: timestamp,
          endedAt: null,
          nodes: [],
        }
        turns.push(current)
      }
      const fallbackId = `${sessionId}:${messageIndex}:${blockIndex}`
      let node: EngineTraceNode | undefined
      if (block.type === "tool_call") {
        const result = results.get(block.callId)
        node = {
          id: block.callId || `tool:${fallbackId}`,
          turnId: current.id,
          parentId,
          parentBasis: parentId ? "temporal" : "none",
          kind: CHANGE_TOOL.test(block.name) ? "change" : "tool",
          status: result?.block.isError ? "error" : result ? "success" : "running",
          title: block.name,
          summary: summary(block.input),
          detail: traceDetail(block.input),
          resultDetail: result ? traceDetail(result.block.output) : null,
          startedAt: timestamp,
          endedAt: result?.at ?? null,
        }
      } else if (block.type === "thinking" && block.text.trim()) {
        node = {
          id: `reasoning:${fallbackId}`,
          turnId: current.id,
          parentId: null,
          parentBasis: "none",
          kind: "reasoning",
          status: "success",
          title: compact(block.text, 140),
          summary: "",
          detail: block.text.trim(),
          resultDetail: null,
          startedAt: timestamp,
          endedAt: timestamp,
        }
        parentId = node.id
      } else if (block.type === "text" && message.role !== "user" && block.text.trim()) {
        const hasToolAfter = message.blocks.slice(blockIndex + 1).some((candidate) => candidate.type === "tool_call")
        const commentary = message.phase === "commentary" || (message.phase === undefined && hasToolAfter)
        node = {
          id: `${commentary ? "commentary" : "answer"}:${fallbackId}`,
          turnId: current.id,
          parentId: null,
          parentBasis: "none",
          kind: commentary ? "commentary" : "answer",
          status: "success",
          title: compact(block.text, 140),
          summary: "",
          detail: block.text.trim(),
          resultDetail: null,
          startedAt: timestamp,
          endedAt: timestamp,
        }
        parentId = commentary ? node.id : null
      }
      if (node) {
        current.nodes.push(node)
        current.endedAt = Math.max(current.endedAt ?? current.startedAt, node.endedAt ?? node.startedAt)
      }
    }
  })

  return {
    sessionId,
    turns: turns.map((turn): EngineTraceTurn => ({ ...turn, status: status(turn.nodes) })),
  }
}
