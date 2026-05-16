import type { EngineEvent } from "@/types/engine"
import { geminiStatsToSnapshot } from "./usage"

export type LineSource = AsyncIterable<string>

export interface ParseGeminiStreamJsonOpts {
  readonly onSessionId?: (sessionId: string) => void
}

export async function* parseStreamJson(
  lines: LineSource,
  opts: ParseGeminiStreamJsonOpts = {},
): AsyncIterable<EngineEvent> {
  const toolNameById = new Map<string, string>()
  for await (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) continue

    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch (err) {
      yield { type: "error", message: `gemini stream-json parse failed: ${stringifyErr(err)}` }
      continue
    }
    if (!isObject(msg) || typeof msg.type !== "string") continue

    switch (msg.type) {
      case "init": {
        const sid = typeof msg.session_id === "string" ? msg.session_id : undefined
        if (sid) opts.onSessionId?.(sid)
        break
      }
      case "message": {
        if (msg.role === "assistant" && typeof msg.content === "string" && msg.content.length > 0) {
          yield { type: "assistant.delta", text: msg.content }
        }
        break
      }
      case "tool_use": {
        const id = typeof msg.tool_id === "string" ? msg.tool_id : undefined
        const name = typeof msg.tool_name === "string" ? msg.tool_name : "tool"
        if (id) toolNameById.set(id, name)
        yield { type: "tool.start", name, input: isObject(msg.parameters) ? msg.parameters : {} }
        break
      }
      case "tool_result": {
        const id = typeof msg.tool_id === "string" ? msg.tool_id : undefined
        const name = (id ? toolNameById.get(id) : undefined) ?? "tool"
        const output = msg.output ?? (isObject(msg.error) ? msg.error : undefined)
        yield { type: "tool.result", name, output }
        break
      }
      case "error": {
        const severity = typeof msg.severity === "string" ? msg.severity : "error"
        const message = typeof msg.message === "string" ? msg.message : "gemini emitted an error"
        if (severity === "error") {
          yield { type: "error", message }
          return
        }
        yield { type: "tool.result", name: "warning", output: message }
        break
      }
      case "result": {
        const status = typeof msg.status === "string" ? msg.status : "success"
        const snapshot = geminiStatsToSnapshot(msg.stats)
        if (snapshot) yield { type: "usage", ...snapshot }
        if (status === "error") {
          yield { type: "error", message: "gemini finished with error status" }
          return
        }
        yield { type: "done" }
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
