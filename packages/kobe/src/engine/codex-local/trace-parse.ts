/** Codex rollout JSONL → engine-owned Agent Trace. */

import type { EngineTrace, EngineTraceNode, EngineTraceStatus, EngineTraceTurn } from "@/types/engine"
import { isJsonlLineWithinBound } from "../file-bounds"
import { traceDetail } from "../trace-from-history"
import { normalizeCodexContent } from "./normalize"
import { isSyntheticCodexUserRow } from "./synthetic"

interface MutableTurn {
  id: string
  title: string
  startedAt: number
  endedAt: number | null
  completionStatus: "success" | "error" | null
  nodes: EngineTraceNode[]
}

interface ResultFact {
  output: unknown
  at: number
  error: boolean
}

const CHANGE_TOOL = /apply.?patch|edit|write|notebook|file.?pen/i

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function compact(value: string, max = 88): string {
  const oneLine = value.replace(/\s+/g, " ").trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function strip(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!keys.includes(key)) out[key] = value
  }
  return out
}

function inputSummary(input: unknown): string {
  const record = object(input)
  if (record) {
    for (const key of ["cmd", "command", "file_path", "path", "query", "prompt"]) {
      const value = record[key]
      if (typeof value === "string" && value.trim()) return compact(value, 72)
    }
  }
  return compact(traceDetail(input), 72)
}

function reasoningText(payload: Record<string, unknown>): string {
  for (const value of [payload.content, payload.text, payload.summary]) {
    if (typeof value === "string" && value.trim()) return value.trim()
    if (!Array.isArray(value)) continue
    const parts = value.flatMap((entry) => {
      if (typeof entry === "string") return entry
      const record = object(entry)
      return typeof record?.text === "string" ? record.text : []
    })
    const text = parts.join("").trim()
    if (text) return text
  }
  return ""
}

function outputIsError(payload: Record<string, unknown>, output: unknown): boolean {
  if (payload.is_error === true || payload.success === false) return true
  if (payload.status === "failed" || payload.status === "error") return true
  const record = object(output)
  if (!record) return false
  if (record.is_error === true || record.success === false) return true
  const exit = record.exit_code ?? object(record.metadata)?.exit_code
  return typeof exit === "number" && exit !== 0
}

function traceStatus(
  nodes: readonly EngineTraceNode[],
  completionStatus: MutableTurn["completionStatus"],
): EngineTraceStatus {
  if (nodes.some((node) => node.status === "error")) return "error"
  if (nodes.some((node) => node.status === "blocked")) return "blocked"
  if (nodes.some((node) => node.status === "running")) return "running"
  return completionStatus ?? "running"
}

class TraceBuilder {
  private readonly turns: MutableTurn[] = []
  private readonly byTurnId = new Map<string, MutableTurn>()
  private readonly nodeLocation = new Map<string, { turn: MutableTurn; index: number }>()
  private readonly pendingResults = new Map<string, ResultFact>()
  private activeTurn: MutableTurn | undefined
  private parentId: string | null = null
  private syntheticTurn = 0
  private syntheticNode = 0

  constructor(private readonly sessionId: string) {}

  startTurn(id: string, at: number): MutableTurn {
    const existing = this.byTurnId.get(id)
    if (existing) {
      if (this.activeTurn !== existing) {
        this.activeTurn = existing
        this.parentId = null
      }
      return existing
    }
    const turn: MutableTurn = {
      id,
      title: "Current turn",
      startedAt: at,
      endedAt: null,
      completionStatus: null,
      nodes: [],
    }
    this.turns.push(turn)
    this.byTurnId.set(id, turn)
    this.activeTurn = turn
    this.parentId = null
    return turn
  }

  ensureTurn(at: number): MutableTurn {
    return this.activeTurn ?? this.startTurn(`turn:${this.sessionId}:fallback:${this.syntheticTurn++}`, at)
  }

  setPrompt(text: string, at: number): void {
    const turn = this.ensureTurn(at)
    turn.title = compact(text)
    turn.startedAt = Math.min(turn.startedAt || at, at)
  }

  addNode(node: EngineTraceNode, becomesParent = false): void {
    const turn = this.ensureTurn(node.startedAt)
    const normalized = { ...node, turnId: turn.id }
    const index = turn.nodes.length
    turn.nodes.push(normalized)
    this.nodeLocation.set(normalized.id, { turn, index })
    turn.endedAt = Math.max(turn.endedAt ?? turn.startedAt, normalized.endedAt ?? normalized.startedAt)
    if (becomesParent) this.parentId = normalized.id
  }

  prose(payload: Record<string, unknown>, at: number, phase: "commentary" | "final" | "reasoning"): void {
    const text =
      phase === "reasoning"
        ? reasoningText(payload)
        : normalizeCodexContent(payload.content)
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .trim()
    if (!text) return
    const rawId = typeof payload.id === "string" ? payload.id : undefined
    const id = rawId ?? `${phase}:${this.sessionId}:${this.syntheticNode++}`
    const kind = phase === "commentary" ? "commentary" : phase === "reasoning" ? "reasoning" : "answer"
    this.addNode(
      {
        id,
        turnId: "",
        parentId: null,
        parentBasis: "none",
        kind,
        status: "success",
        title: compact(text, 140),
        summary: "",
        detail: traceDetail(text),
        resultDetail: null,
        startedAt: at,
        endedAt: at,
      },
      phase !== "final",
    )
    if (phase === "final") this.parentId = null
  }

  tool(callId: string, name: string, input: unknown, at: number, immediate?: ResultFact): void {
    const result = immediate ?? this.pendingResults.get(callId)
    this.addNode({
      id: callId,
      turnId: "",
      parentId: this.parentId,
      parentBasis: this.parentId ? "temporal" : "none",
      kind: CHANGE_TOOL.test(name) ? "change" : "tool",
      status: result?.error ? "error" : result ? "success" : "running",
      title: name,
      summary: inputSummary(input),
      detail: traceDetail(input),
      resultDetail: result ? traceDetail(result.output) : null,
      startedAt: at,
      endedAt: result?.at ?? null,
    })
    this.pendingResults.delete(callId)
  }

  result(callId: string, fact: ResultFact): void {
    const location = this.nodeLocation.get(callId)
    if (!location) {
      this.pendingResults.set(callId, fact)
      return
    }
    const current = location.turn.nodes[location.index]
    if (!current) return
    location.turn.nodes[location.index] = {
      ...current,
      status: fact.error ? "error" : "success",
      resultDetail: traceDetail(fact.output),
      endedAt: fact.at,
    }
    location.turn.endedAt = Math.max(location.turn.endedAt ?? location.turn.startedAt, fact.at)
  }

  completeTurn(id: string | undefined, at: number, failed: boolean): void {
    const turn = (id ? this.byTurnId.get(id) : undefined) ?? this.activeTurn
    if (!turn) return
    turn.endedAt = Math.max(turn.endedAt ?? turn.startedAt, at)
    turn.completionStatus = failed ? "error" : "success"
    if (turn === this.activeTurn) {
      this.activeTurn = undefined
      this.parentId = null
    }
  }

  build(): EngineTrace {
    return {
      sessionId: this.sessionId,
      turns: this.turns.map((turn): EngineTraceTurn => {
        const { completionStatus, ...value } = turn
        return {
          ...value,
          status: traceStatus(turn.nodes, completionStatus),
        }
      }),
    }
  }
}

function responseItem(builder: TraceBuilder, payload: Record<string, unknown>, at: number): void {
  const type = payload.type
  if (type === "message") {
    const role = payload.role
    const blocks = normalizeCodexContent(payload.content)
    if (role === "user") {
      if (isSyntheticCodexUserRow(blocks)) return
      const text = blocks
        .filter((block) => block.type === "text")
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n")
      if (text) builder.setPrompt(text, at)
      return
    }
    if (role !== "assistant") return
    builder.prose(payload, at, payload.phase === "commentary" ? "commentary" : "final")
    return
  }
  if (type === "reasoning") {
    builder.prose(payload, at, "reasoning")
    return
  }

  const callId = typeof payload.call_id === "string" && payload.call_id ? payload.call_id : undefined
  if (type === "function_call" || type === "custom_tool_call" || type === "tool_search_call") {
    if (!callId) return
    const name = typeof payload.name === "string" && payload.name ? payload.name : String(type)
    const rawInput =
      type === "function_call"
        ? payload.arguments
        : type === "custom_tool_call"
          ? payload.input
          : strip(payload, ["type", "call_id", "status"])
    builder.tool(callId, name, parseMaybeJson(rawInput), at)
    return
  }
  if (type === "function_call_output" || type === "custom_tool_call_output" || type === "tool_search_output") {
    if (!callId) return
    const output = type === "tool_search_output" ? strip(payload, ["type", "call_id"]) : parseMaybeJson(payload.output)
    builder.result(callId, {
      output,
      at,
      error: outputIsError(payload, output),
    })
    return
  }
  if (type === "web_search_call" || type === "image_generation_call" || type === "local_shell_call") {
    const id = (typeof payload.id === "string" && payload.id) || callId || `${String(type)}:${at}`
    const input = strip(payload, ["type", "call_id", "status", "output"])
    const output = payload.output ?? strip(payload, ["type", "call_id"])
    builder.tool(id, String(type), input, at, {
      output,
      at,
      error: outputIsError(payload, output),
    })
  }
}

/** Parse a complete rollout. Invalid/oversize records are skipped. */
export function parseCodexTrace(raw: string, sessionId: string): EngineTrace {
  const builder = new TraceBuilder(sessionId)
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || !isJsonlLineWithinBound(trimmed)) continue
    let record: Record<string, unknown> | undefined
    try {
      record = object(JSON.parse(trimmed))
    } catch {
      continue
    }
    if (!record) continue
    const at = timestamp(record.timestamp)
    const payload = object(record.payload)
    if (record.type === "turn_context") {
      const turnId = typeof record.turn_id === "string" ? record.turn_id : null
      if (turnId) builder.startTurn(turnId, at)
    } else if (record.type === "event_msg" && payload) {
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : undefined
      if (payload.type === "task_started" && turnId) builder.startTurn(turnId, at)
      else if (payload.type === "task_complete") builder.completeTurn(turnId, at, false)
      else if (payload.type === "task_failed") builder.completeTurn(turnId, at, true)
    } else if (record.type === "response_item" && payload) {
      responseItem(builder, payload, at)
    }
  }
  return builder.build()
}
