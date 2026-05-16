import { readFile, readdir, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { ContentBlock } from "@/types/content"
import type { EngineHistory, EngineUsageSnapshot, Message } from "@/types/engine"

export interface CopilotHistoryDeps {
  copilotDir(): string
  readdir(p: string): Promise<string[]>
  readFile(p: string): Promise<string>
  unlink(p: string): Promise<void>
}

const defaultDeps: CopilotHistoryDeps = {
  copilotDir() {
    return path.join(homedir(), ".copilot")
  },
  async readdir(p) {
    try {
      return await readdir(p)
    } catch {
      return []
    }
  },
  async readFile(p) {
    return await readFile(p, "utf8")
  },
  unlink,
}

export async function readHistoryWithMetrics(
  sessionId: string,
  deps: CopilotHistoryDeps = defaultDeps,
): Promise<EngineHistory> {
  const file = sessionEventsPath(deps.copilotDir(), sessionId)
  const raw = await deps.readFile(file).catch(() => "")
  if (!raw) return { messages: [] }
  const messages = parseEventsJsonl(raw, sessionId)
  const usageMetrics = deriveUsage(raw)
  return { messages, ...(usageMetrics ? { usageMetrics } : {}) }
}

export async function readHistory(sessionId: string, deps: CopilotHistoryDeps = defaultDeps): Promise<Message[]> {
  return (await readHistoryWithMetrics(sessionId, deps)).messages as Message[]
}

export async function deleteHistory(sessionId: string, deps: CopilotHistoryDeps = defaultDeps): Promise<void> {
  const file = sessionEventsPath(deps.copilotDir(), sessionId)
  await deps.unlink(file).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "ENOENT") throw err
  })
}

export function sessionEventsPath(copilotDir: string, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId)) throw new Error("Invalid Copilot session id")
  const sessionStateDir = path.resolve(copilotDir, "session-state")
  const file = path.resolve(sessionStateDir, sessionId, "events.jsonl")
  if (!file.startsWith(`${sessionStateDir}${path.sep}`)) throw new Error("Invalid Copilot session id")
  return file
}

export function parseEventsJsonl(raw: string, sessionId: string): Message[] {
  const out: Message[] = []
  const startedTools = new Set<string>()
  const seenReasoningTexts = new Set<string>()
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    let record: unknown
    try {
      record = JSON.parse(t)
    } catch {
      continue
    }
    if (!isObject(record) || typeof record.type !== "string") continue
    const data = isObject(record.data) ? record.data : {}
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString()

    if (record.type === "user.message") {
      const text = typeof data.content === "string" ? data.content : ""
      if (text) out.push({ role: "user", blocks: [{ type: "text", text }], timestamp, sessionId })
      continue
    }

    if (record.type === "assistant.message") {
      const blocks: ContentBlock[] = []
      const reasoningText = typeof data.reasoningText === "string" ? data.reasoningText : ""
      if (reasoningText && !seenReasoningTexts.has(reasoningKey(reasoningText))) {
        seenReasoningTexts.add(reasoningKey(reasoningText))
        blocks.push({ type: "thinking", text: reasoningText })
      }
      const text = typeof data.content === "string" ? data.content : ""
      if (text) blocks.push({ type: "text", text })
      for (const request of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
        const tool = normalizeToolRequest(request)
        if (!tool) continue
        startedTools.add(tool.id)
        blocks.push({ type: "tool_call", callId: tool.id, name: tool.name, input: tool.input })
      }
      if (blocks.length > 0) out.push({ role: "assistant", blocks, timestamp, sessionId, usage: usageFromData(data) })
      continue
    }

    if (record.type === "assistant.reasoning") {
      const text = typeof data.content === "string" ? data.content : ""
      const key = reasoningKey(text)
      if (text && !seenReasoningTexts.has(key)) {
        seenReasoningTexts.add(key)
        out.push({ role: "assistant", blocks: [{ type: "thinking", text }], timestamp, sessionId })
      }
      continue
    }

    if (record.type === "tool.execution_start") {
      const id = typeof data.toolCallId === "string" ? data.toolCallId : undefined
      if (!id || startedTools.has(id)) continue
      const name = typeof data.toolName === "string" ? data.toolName : "tool"
      startedTools.add(id)
      out.push({
        role: "assistant",
        blocks: [{ type: "tool_call", callId: id, name, input: normalizeToolArgs(data.arguments) }],
        timestamp,
        sessionId,
      })
      continue
    }

    if (record.type === "tool.execution_complete") {
      const id = typeof data.toolCallId === "string" ? data.toolCallId : undefined
      if (!id) continue
      out.push({
        role: "assistant",
        blocks: [
          {
            type: "tool_result",
            callId: id,
            output: data.result ?? { success: data.success },
            isError: data.success === false,
          },
        ],
        timestamp,
        sessionId,
      })
    }
  }
  return out
}

function usageFromData(data: Record<string, unknown>): Message["usage"] | undefined {
  const output = numberOr(data.outputTokens, 0)
  if (output === 0) return undefined
  return { input_tokens: 0, output_tokens: output }
}

function deriveUsage(raw: string): EngineUsageSnapshot | undefined {
  let output = 0
  let context = 0
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    try {
      const record = JSON.parse(line) as unknown
      if (!isObject(record) || !isObject(record.data)) continue
      if (record.type === "assistant.message") output += numberOr(record.data.outputTokens, 0)
      if (record.type === "session.shutdown") context = Math.max(context, numberOr(record.data.currentTokens, 0))
    } catch {}
  }
  if (output === 0 && context === 0) return undefined
  return { input_tokens: 0, output_tokens: output, ...(context > 0 ? { context_tokens: context } : {}) }
}

function normalizeToolRequest(value: unknown): { id: string; name: string; input: unknown } | null {
  if (!isObject(value)) return null
  const id =
    typeof value.id === "string" ? value.id : typeof value.toolCallId === "string" ? value.toolCallId : undefined
  const name =
    typeof value.name === "string" ? value.name : typeof value.toolName === "string" ? value.toolName : undefined
  if (!id || !name) return null
  return { id, name, input: normalizeToolArgs(value.arguments ?? value.input) }
}

function normalizeToolArgs(value: unknown): unknown {
  if (!Array.isArray(value)) return value ?? {}
  if (value.length === 0) return {}
  const out: Record<string, unknown> = {}
  for (const entry of value) {
    if (isObject(entry)) Object.assign(out, entry)
  }
  return Object.keys(out).length > 0 ? out : value
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function reasoningKey(text: string): string {
  return text.trim()
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
