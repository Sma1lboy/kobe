import { readFile, readdir, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { ContentBlock } from "@/types/content"
import type { EngineHistory, EngineUsageSnapshot, Message } from "@/types/engine"

export interface GeminiHistoryDeps {
  geminiDir(): string
  readdir(p: string): Promise<string[]>
  readFile(p: string): Promise<string>
  unlink(p: string): Promise<void>
}

const defaultDeps: GeminiHistoryDeps = {
  geminiDir() {
    return path.join(homedir(), ".gemini")
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

export async function listChatFiles(deps: GeminiHistoryDeps = defaultDeps): Promise<string[]> {
  const roots = [path.join(deps.geminiDir(), "tmp"), path.join(deps.geminiDir(), "history")]
  const out: string[] = []
  for (const root of roots) {
    for (const projectId of await deps.readdir(root)) {
      const chatsDir = path.join(root, projectId, "chats")
      const files = (await deps.readdir(chatsDir)).filter(
        (f) => f.startsWith("session-") && (f.endsWith(".jsonl") || f.endsWith(".json")),
      )
      for (const f of files) out.push(path.join(chatsDir, f))
    }
  }
  return out
}

export async function readHistoryWithMetrics(
  sessionId: string,
  deps: GeminiHistoryDeps = defaultDeps,
): Promise<EngineHistory> {
  const file = await findChatFile(sessionId, deps)
  if (!file) return { messages: [] }
  let raw: string
  try {
    raw = await deps.readFile(file)
  } catch {
    return { messages: [] }
  }
  const conversation = parseConversation(raw)
  if (!conversation) return { messages: [] }
  const messages = conversation.messages.flatMap((msg) => normalizeGeminiMessage(msg, conversation.sessionId))
  const usageMetrics = deriveUsage(messages)
  return { messages, ...(usageMetrics ? { usageMetrics } : {}) }
}

export async function readHistory(sessionId: string, deps: GeminiHistoryDeps = defaultDeps): Promise<Message[]> {
  return (await readHistoryWithMetrics(sessionId, deps)).messages as Message[]
}

export async function deleteHistory(sessionId: string, deps: GeminiHistoryDeps = defaultDeps): Promise<void> {
  const short = sessionId.slice(0, 8)
  for (const file of await listChatFiles(deps)) {
    if (!path.basename(file).includes(short)) continue
    const raw = await deps.readFile(file).catch(() => "")
    const conversation = parseConversation(raw)
    if (conversation?.sessionId !== sessionId) continue
    await deps.unlink(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== "ENOENT") throw err
    })
  }
}

async function findChatFile(sessionId: string, deps: GeminiHistoryDeps): Promise<string | undefined> {
  const short = sessionId.slice(0, 8)
  for (const file of await listChatFiles(deps)) {
    if (!path.basename(file).includes(short)) continue
    const raw = await deps.readFile(file).catch(() => "")
    const conversation = parseConversation(raw, { metadataOnly: true })
    if (conversation?.sessionId === sessionId) return file
  }
  return undefined
}

export interface GeminiConversation {
  readonly sessionId: string
  readonly projectHash?: string
  readonly startTime: string
  readonly lastUpdated: string
  readonly kind?: string
  readonly summary?: string
  readonly messages: readonly GeminiRecordMessage[]
  readonly firstUserMessage?: string
}

export interface GeminiRecordMessage {
  readonly id?: string
  readonly timestamp?: string
  readonly type?: string
  readonly content?: unknown
  readonly displayContent?: unknown
  readonly thoughts?: readonly unknown[]
  readonly toolCalls?: readonly unknown[]
  readonly tokens?: unknown
  readonly model?: string
}

export function parseConversation(raw: string, opts: { metadataOnly?: boolean } = {}): GeminiConversation | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed)
      return normalizeLegacyConversation(parsed)
    } catch {
      /* fall through to newline-record parsing */
    }
  }

  let metadata: Record<string, unknown> = {}
  const messagesById = new Map<string, GeminiRecordMessage>()
  const messageOrder: string[] = []
  let firstUserMessage: string | undefined

  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (!t) continue
    let record: unknown
    try {
      record = JSON.parse(t)
    } catch {
      continue
    }
    if (!isObject(record)) continue
    if (typeof record.$rewindTo === "string") {
      const idx = messageOrder.indexOf(record.$rewindTo)
      const removed = idx >= 0 ? messageOrder.splice(idx) : messageOrder.splice(0)
      for (const id of removed) messagesById.delete(id)
      continue
    }
    if (isObject(record.$set)) {
      metadata = { ...metadata, ...record.$set }
      continue
    }
    if (typeof record.sessionId === "string") {
      metadata = { ...metadata, ...record }
      continue
    }
    if (typeof record.id === "string") {
      const msg = record as GeminiRecordMessage
      if (!opts.metadataOnly) messagesById.set(record.id, msg)
      if (!messageOrder.includes(record.id)) messageOrder.push(record.id)
      if (!firstUserMessage && msg.type === "user") firstUserMessage = textFromParts(msg.displayContent ?? msg.content)
    }
  }

  const sessionId = typeof metadata.sessionId === "string" ? metadata.sessionId : undefined
  if (!sessionId) return null
  return {
    sessionId,
    projectHash: stringOrUndefined(metadata.projectHash),
    startTime: stringOrUndefined(metadata.startTime) ?? new Date().toISOString(),
    lastUpdated: stringOrUndefined(metadata.lastUpdated) ?? new Date().toISOString(),
    kind: stringOrUndefined(metadata.kind),
    summary: stringOrUndefined(metadata.summary),
    messages: opts.metadataOnly ? [] : messageOrder.flatMap((id) => messagesById.get(id) ?? []),
    firstUserMessage,
  }
}

function normalizeLegacyConversation(v: unknown): GeminiConversation | null {
  if (!isObject(v) || typeof v.sessionId !== "string") return null
  return {
    sessionId: v.sessionId,
    projectHash: stringOrUndefined(v.projectHash),
    startTime: stringOrUndefined(v.startTime) ?? new Date().toISOString(),
    lastUpdated: stringOrUndefined(v.lastUpdated) ?? new Date().toISOString(),
    kind: stringOrUndefined(v.kind),
    summary: stringOrUndefined(v.summary),
    messages: Array.isArray(v.messages) ? (v.messages as GeminiRecordMessage[]) : [],
  }
}

function normalizeGeminiMessage(msg: GeminiRecordMessage, sessionId: string): Message[] {
  const timestamp = msg.timestamp ?? new Date().toISOString()
  const out: Message[] = []
  if (msg.type === "user") {
    const text = textFromParts(msg.displayContent ?? msg.content)
    if (text) out.push({ role: "user", blocks: [{ type: "text", text }], timestamp, sessionId })
    return out
  }
  if (msg.type !== "gemini") return out

  const blocks: ContentBlock[] = []
  for (const thought of msg.thoughts ?? []) {
    const text = thoughtText(thought)
    if (text) blocks.push({ type: "thinking", text })
  }
  const text = textFromParts(msg.displayContent ?? msg.content)
  if (text) blocks.push({ type: "text", text })
  for (const tool of msg.toolCalls ?? []) {
    if (!isObject(tool)) continue
    const callId = typeof tool.id === "string" ? tool.id : typeof tool.callId === "string" ? tool.callId : "gemini-tool"
    const name =
      typeof tool.name === "string" ? tool.name : typeof tool.displayName === "string" ? tool.displayName : "tool"
    blocks.push({ type: "tool_call", callId, name, input: tool.args ?? {} })
    if ("response" in tool)
      blocks.push({ type: "tool_result", callId, output: tool.response, isError: tool.status === "error" })
  }
  if (blocks.length === 0) return out
  out.push({
    role: "assistant",
    blocks,
    timestamp,
    sessionId,
    ...(usageFromTokens(msg.tokens) ? { usage: usageFromTokens(msg.tokens) } : {}),
  })
  return out
}

function usageFromTokens(tokens: unknown): Message["usage"] | undefined {
  if (!isObject(tokens)) return undefined
  return {
    input_tokens: numberOr(tokens.input, 0),
    output_tokens: numberOr(tokens.output, 0),
    cache_read_input_tokens: numberOr(tokens.cached, 0),
  }
}

function deriveUsage(messages: readonly Message[]): EngineUsageSnapshot | undefined {
  let input = 0
  let output = 0
  let cached = 0
  for (const m of messages) {
    if (!m.usage) continue
    input += m.usage.input_tokens
    output += m.usage.output_tokens
    cached += m.usage.cache_read_input_tokens ?? 0
  }
  if (input === 0 && output === 0 && cached === 0) return undefined
  return { input_tokens: input, output_tokens: output, ...(cached > 0 ? { cache_read_input_tokens: cached } : {}) }
}

export function textFromParts(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  const parts: string[] = []
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part)
    } else if (isObject(part) && typeof part.text === "string") {
      parts.push(part.text)
    }
  }
  return parts.join("")
}

function thoughtText(value: unknown): string {
  if (!isObject(value)) return ""
  const subject = typeof value.subject === "string" ? value.subject : ""
  const description = typeof value.description === "string" ? value.description : ""
  return [subject, description].filter(Boolean).join("\n")
}

function stringOrUndefined(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
