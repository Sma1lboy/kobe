import type { EngineEvent } from "@/types/engine"

export type LineSource = AsyncIterable<string>

export interface ParseCopilotStreamJsonOpts {
  readonly onSessionId?: (sessionId: string) => void
}

export async function* parseStreamJson(
  lines: LineSource,
  opts: ParseCopilotStreamJsonOpts = {},
): AsyncIterable<EngineEvent> {
  const toolNameById = new Map<string, string>()
  const startedToolIds = new Set<string>()
  const completedMessageIds = new Set<string>()
  const streamedReasoningIds = new Set<string>()
  const reasoningTextById = new Map<string, string>()
  const completedReasoningTexts = new Set<string>()
  let terminalSeen = false

  for await (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch (err) {
      yield { type: "error", message: `copilot stream-json parse failed: ${stringifyErr(err)}` }
      continue
    }
    if (!isObject(msg) || typeof msg.type !== "string") continue

    const data = isObject(msg.data) ? msg.data : {}
    switch (msg.type) {
      case "session.start": {
        const sid = typeof data.sessionId === "string" ? data.sessionId : undefined
        if (sid) opts.onSessionId?.(sid)
        break
      }
      case "assistant.message_delta": {
        const text = typeof data.deltaContent === "string" ? data.deltaContent : ""
        const id = typeof data.messageId === "string" ? data.messageId : undefined
        if (id) completedMessageIds.add(id)
        if (text) yield { type: "assistant.delta", text }
        break
      }
      case "assistant.message": {
        const id = typeof data.messageId === "string" ? data.messageId : undefined
        const reasoningText = typeof data.reasoningText === "string" ? data.reasoningText : ""
        if (reasoningText && !hasReasoningText(completedReasoningTexts, reasoningTextById, reasoningText)) {
          completedReasoningTexts.add(reasoningKey(reasoningText))
          yield { type: "reasoning.delta", text: reasoningText }
        }
        const text = typeof data.content === "string" ? data.content : ""
        if (text && (!id || !completedMessageIds.has(id))) yield { type: "assistant.delta", text }
        for (const request of Array.isArray(data.toolRequests) ? data.toolRequests : []) {
          const tool = normalizeToolRequest(request)
          if (!tool) continue
          if (startedToolIds.has(tool.id)) continue
          startedToolIds.add(tool.id)
          toolNameById.set(tool.id, tool.name)
          yield { type: "tool.start", name: tool.name, input: tool.input }
        }
        break
      }
      case "assistant.reasoning": {
        const id = typeof data.reasoningId === "string" ? data.reasoningId : undefined
        const text = typeof data.content === "string" ? data.content : ""
        const alreadySeen = text ? hasReasoningText(completedReasoningTexts, reasoningTextById, text) : false
        if (text) completedReasoningTexts.add(reasoningKey(text))
        if (text && !alreadySeen && (!id || !streamedReasoningIds.has(id))) {
          yield { type: "reasoning.delta", text }
        }
        break
      }
      case "assistant.reasoning_delta": {
        const text = typeof data.deltaContent === "string" ? data.deltaContent : ""
        const id = typeof data.reasoningId === "string" ? data.reasoningId : undefined
        if (id) {
          streamedReasoningIds.add(id)
          reasoningTextById.set(id, `${reasoningTextById.get(id) ?? ""}${text}`)
        } else if (text) {
          const fallbackId = "__copilot_reasoning__"
          reasoningTextById.set(fallbackId, `${reasoningTextById.get(fallbackId) ?? ""}${text}`)
        }
        if (text) yield { type: "reasoning.delta", text }
        break
      }
      case "tool.execution_start": {
        const id = typeof data.toolCallId === "string" ? data.toolCallId : undefined
        const name = typeof data.toolName === "string" ? data.toolName : "tool"
        if (id) {
          if (startedToolIds.has(id)) break
          startedToolIds.add(id)
          toolNameById.set(id, name)
        }
        yield { type: "tool.start", name, input: normalizeToolArgs(data.arguments) }
        break
      }
      case "tool.execution_complete": {
        const id = typeof data.toolCallId === "string" ? data.toolCallId : undefined
        const name = (id ? toolNameById.get(id) : undefined) ?? "tool"
        yield { type: "tool.result", name, output: data.result ?? { success: data.success } }
        break
      }
      case "error": {
        const message = typeof data.message === "string" ? data.message : "copilot emitted an error"
        yield { type: "error", message }
        return
      }
      case "result": {
        const sid = typeof msg.sessionId === "string" ? msg.sessionId : undefined
        if (sid) opts.onSessionId?.(sid)
        const exitCode = typeof msg.exitCode === "number" ? msg.exitCode : 0
        if (exitCode !== 0) {
          yield { type: "error", message: `copilot exited with code ${exitCode}` }
          return
        }
        terminalSeen = true
        yield { type: "done" }
        return
      }
    }
  }

  if (!terminalSeen) yield { type: "done" }
}

export async function* readLines(stream: AsyncIterable<unknown>): AsyncIterable<string> {
  let buf = ""
  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    buf += text
    let nl = buf.indexOf("\n")
    while (nl !== -1) {
      yield buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      nl = buf.indexOf("\n")
    }
  }
  if (buf.length > 0) yield buf
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

function hasReasoningText(completed: Set<string>, streamed: Map<string, string>, text: string): boolean {
  const key = reasoningKey(text)
  return completed.has(key) || reasoningTextByIdHas(streamed, text)
}

function reasoningTextByIdHas(streamed: Map<string, string>, text: string): boolean {
  const key = reasoningKey(text)
  for (const value of streamed.values()) {
    if (reasoningKey(value) === key) return true
  }
  return false
}

function reasoningKey(text: string): string {
  return text.trim()
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

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
