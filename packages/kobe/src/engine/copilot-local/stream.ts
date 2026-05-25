import type { EngineEvent, EngineUsageSnapshot } from "@/types/engine"

export type LineSource = AsyncIterable<string>

export interface ParseCopilotJsonOpts {
  readonly onSessionId?: (sessionId: string) => void
}

export async function* parseCopilotJson(
  lines: LineSource,
  opts: ParseCopilotJsonOpts = {},
): AsyncIterable<EngineEvent> {
  const completedMessages = new Set<string>()
  const toolNameById = new Map<string, string>()
  let sawAssistantDelta = false

  for await (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch (err) {
      yield { type: "error", message: `copilot JSON parse failed: ${stringifyErr(err)}` }
      continue
    }
    if (!isObject(msg) || typeof msg.type !== "string") continue

    switch (msg.type) {
      case "session.start": {
        const data = objectData(msg)
        const sid = typeof data?.sessionId === "string" ? data.sessionId : undefined
        if (sid) opts.onSessionId?.(sid)
        break
      }
      case "assistant.message_delta": {
        const data = objectData(msg)
        const text = typeof data?.deltaContent === "string" ? data.deltaContent : ""
        if (text) {
          sawAssistantDelta = true
          yield { type: "assistant.delta", text }
        }
        break
      }
      case "assistant.message": {
        const data = objectData(msg)
        const messageId = typeof data?.messageId === "string" ? data.messageId : undefined
        const content = typeof data?.content === "string" ? data.content : ""
        if (messageId) {
          if (completedMessages.has(messageId)) break
          completedMessages.add(messageId)
        }
        if (sawAssistantDelta) break
        if (content) yield { type: "assistant.delta", text: content }
        break
      }
      case "assistant.reasoning": {
        const data = objectData(msg)
        const text = typeof data?.content === "string" ? data.content : ""
        if (text) yield { type: "reasoning.delta", text }
        break
      }
      case "tool.execution_start": {
        const data = objectData(msg)
        const id = typeof data?.toolCallId === "string" ? data.toolCallId : undefined
        const name = typeof data?.toolName === "string" ? data.toolName : "tool"
        if (id) toolNameById.set(id, name)
        yield { type: "tool.start", name, input: data?.arguments ?? {}, ...(id ? { id } : {}) }
        break
      }
      case "tool.execution_complete": {
        const data = objectData(msg)
        const id = typeof data?.toolCallId === "string" ? data.toolCallId : undefined
        const name =
          (id ? toolNameById.get(id) : undefined) ?? (typeof data?.toolName === "string" ? data.toolName : "tool")
        const output = data?.result ?? (data?.success === false ? { success: false } : undefined)
        yield { type: "tool.result", name, output }
        break
      }
      case "result": {
        const data = objectData(msg)
        const sid = typeof data?.sessionId === "string" ? data.sessionId : undefined
        if (sid) opts.onSessionId?.(sid)
        const usage = copilotUsageToSnapshot(data?.usage)
        if (usage) yield { type: "usage", ...usage }
        const exitCode = data?.exitCode
        if (typeof exitCode === "number" && exitCode !== 0) {
          yield { type: "error", message: `copilot exited with code ${exitCode}` }
          return
        }
        yield { type: "done" }
        return
      }
      case "error": {
        const data = objectData(msg)
        const message =
          (typeof data?.message === "string" && data.message) ||
          (typeof msg.message === "string" && msg.message) ||
          "copilot emitted an error"
        yield { type: "error", message }
        return
      }
    }
  }
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

export function copilotUsageToSnapshot(value: unknown): EngineUsageSnapshot | undefined {
  if (!isObject(value)) return undefined
  const modelMetrics = isObject(value.modelMetrics) ? value.modelMetrics : undefined
  if (!modelMetrics) return undefined
  let input = 0
  let output = 0
  let cached = 0
  for (const metrics of Object.values(modelMetrics)) {
    if (!isObject(metrics) || !isObject(metrics.usage)) continue
    input += numberOr(metrics.usage.inputTokens, 0)
    output += numberOr(metrics.usage.outputTokens, 0)
    cached += numberOr(metrics.usage.cacheReadTokens, 0)
  }
  const context = numberOr(value.currentTokens, 0)
  if (input === 0 && output === 0 && cached === 0 && context === 0) return undefined
  return {
    input_tokens: input,
    output_tokens: output,
    ...(cached > 0 ? { cache_read_input_tokens: cached } : {}),
    ...(context > 0 ? { context_tokens: context } : {}),
  }
}

function objectData(msg: Record<string, unknown>): Record<string, unknown> | undefined {
  return isObject(msg.data) ? msg.data : msg
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
