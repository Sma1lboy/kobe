import { spawn as nodeSpawn } from "node:child_process"
import { normalizeCodexContent } from "../codex-local/normalize.ts"
import { type RunTurnEngineSettings, readRunTurnSettings } from "../run-turn-settings.ts"

export const CODEX_EXEC_SANDBOXES = ["read-only", "workspace-write", "danger-full-access"] as const
export type CodexExecSandbox = (typeof CODEX_EXEC_SANDBOXES)[number]

export const CODEX_EXEC_APPROVALS = ["untrusted", "on-failure", "on-request", "never"] as const
export type CodexExecApproval = (typeof CODEX_EXEC_APPROVALS)[number]

export type RunTurnPurpose = "default" | "small"

export type RunTurnEvent =
  | { readonly type: "assistant_text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "tool"; readonly name: string; readonly input?: unknown; readonly output?: unknown }
  | { readonly type: "stderr"; readonly text: string }
  | { readonly type: "turn_completed"; readonly usage?: unknown }
  | { readonly type: "exit"; readonly code: number | null }

export interface BuildCodexExecArgsOptions {
  readonly prompt: string
  readonly worktree: string
  readonly model?: string
  readonly effort?: string
  readonly sandbox?: CodexExecSandbox
  readonly approval?: CodexExecApproval
  readonly ephemeral?: boolean
}

export interface ResolveRunTurnModelOptions {
  readonly explicitModel?: string
  readonly purpose: RunTurnPurpose
  readonly settings: Pick<RunTurnEngineSettings, "model" | "smallModel">
}

export interface CodexRunTurnOptions extends BuildCodexExecArgsOptions {
  readonly purpose?: RunTurnPurpose
  readonly onEvent?: (event: RunTurnEvent) => void
  readonly signal?: AbortSignal
}

export interface CodexRunTurnResult {
  readonly vendor: "codex"
  readonly argv: readonly string[]
  readonly text: string
  readonly events: readonly RunTurnEvent[]
  readonly exitCode: number | null
  readonly stderr: string
}

export class CodexRunTurnError extends Error {
  constructor(
    message: string,
    readonly result: CodexRunTurnResult,
  ) {
    super(message)
  }
}

export function normalizeCodexExecSandbox(value: string | undefined): CodexExecSandbox | undefined {
  return CODEX_EXEC_SANDBOXES.includes(value as CodexExecSandbox) ? (value as CodexExecSandbox) : undefined
}

export function normalizeCodexExecApproval(value: string | undefined): CodexExecApproval | undefined {
  return CODEX_EXEC_APPROVALS.includes(value as CodexExecApproval) ? (value as CodexExecApproval) : undefined
}

export function resolveRunTurnModel(options: ResolveRunTurnModelOptions): string | undefined {
  const explicit = options.explicitModel?.trim()
  if (explicit) return explicit
  const configured = options.purpose === "small" ? options.settings.smallModel : options.settings.model
  const trimmed = configured.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export function buildCodexExecArgs(options: BuildCodexExecArgsOptions): string[] {
  const args = ["exec", "--json", "-C", options.worktree]
  const model = options.model?.trim()
  if (model) args.push("-m", model)
  const effort = normalizeCodexEffort(options.effort)
  if (effort) args.push("-c", `model_reasoning_effort=${effort}`)
  args.push("-s", options.sandbox ?? "workspace-write")
  args.push("-a", options.approval ?? "never")
  if (options.ephemeral) args.push("--ephemeral")
  args.push(options.prompt)
  return args
}

function normalizeCodexEffort(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return ["none", "low", "medium", "high", "xhigh"].includes(trimmed) ? trimmed : undefined
}

export function parseCodexExecJsonLine(line: string): RunTurnEvent[] {
  const trimmed = line.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed) as unknown
  } catch {
    return []
  }
  if (!isObject(parsed)) return []

  if (parsed.type === "response_item") {
    const payload = isObject(parsed.payload) ? (parsed.payload as Record<string, unknown>) : undefined
    return payload ? eventsFromCodexResponseItem(payload) : []
  }

  if (parsed.type === "response.output_text.delta" || parsed.type === "output_text_delta") {
    const text = stringOr(parsed.delta, "")
    return text ? [{ type: "assistant_text", text }] : []
  }

  if (parsed.type === "response.reasoning_summary.delta" || parsed.type === "reasoning_delta") {
    const text = stringOr(parsed.delta, "")
    return text ? [{ type: "reasoning", text }] : []
  }

  if (parsed.type === "turn.completed") {
    return [{ type: "turn_completed", usage: parsed.usage }]
  }

  if (parsed.type === "error") {
    const message = stringOr(parsed.message, stringOr(parsed.error, "codex error"))
    return message ? [{ type: "stderr", text: `${message}\n` }] : []
  }

  return []
}

function eventsFromCodexResponseItem(payload: Record<string, unknown>): RunTurnEvent[] {
  if (payload.type === "message") {
    if (payload.role !== "assistant") return []
    return normalizeCodexContent(payload.content)
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => ({ type: "assistant_text", text: block.text }))
  }

  if (payload.type === "reasoning") {
    const text = reasoningTextFromItem(payload)
    return text ? [{ type: "reasoning", text }] : []
  }

  if (payload.type === "function_call" || payload.type === "custom_tool_call" || payload.type === "tool_search_call") {
    return [
      {
        type: "tool",
        name: stringOr(payload.name, stringOr(payload.type, "tool")),
        input: parseMaybeJson(payload.arguments ?? payload.input),
      },
    ]
  }

  if (
    payload.type === "function_call_output" ||
    payload.type === "custom_tool_call_output" ||
    payload.type === "tool_search_output"
  ) {
    return [
      {
        type: "tool",
        name: stringOr(payload.type, "tool_output"),
        output: parseMaybeJson(payload.output),
      },
    ]
  }

  return []
}

function reasoningTextFromItem(item: Record<string, unknown>): string {
  const content = textFromReasoningValue(item.content)
  if (content) return content
  const text = stringOr(item.text, "")
  if (text) return text
  return textFromReasoningValue(item.summary)
}

function textFromReasoningValue(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  const parts: string[] = []
  for (const entry of value) {
    if (typeof entry === "string") {
      parts.push(entry)
      continue
    }
    if (!isObject(entry)) continue
    const text = stringOr(entry.text, "")
    if (text) parts.push(text)
  }
  return parts.join("")
}

export async function runCodexHeadlessTurn(options: CodexRunTurnOptions): Promise<CodexRunTurnResult> {
  const settings = readRunTurnSettings("codex")
  const purpose = options.purpose ?? "default"
  const model = resolveRunTurnModel({ explicitModel: options.model, purpose, settings })
  const effort = options.effort?.trim() || settings.effort
  const argv = buildCodexExecArgs({
    ...options,
    model,
    effort,
    ephemeral: options.ephemeral ?? purpose === "small",
  })
  const events: RunTurnEvent[] = []
  const textParts: string[] = []
  const stderrParts: string[] = []

  const emit = (event: RunTurnEvent) => {
    events.push(event)
    if (event.type === "assistant_text") textParts.push(event.text)
    if (event.type === "stderr") stderrParts.push(event.text)
    options.onEvent?.(event)
  }

  const child = nodeSpawn("codex", argv, {
    cwd: options.worktree,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    signal: options.signal,
  })

  let stdoutBuffer = ""
  let stderr = ""
  child.stdout.setEncoding("utf8")
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk
    let newline = stdoutBuffer.indexOf("\n")
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline)
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      for (const event of parseCodexExecJsonLine(line)) emit(event)
      newline = stdoutBuffer.indexOf("\n")
    }
  })
  child.stderr.setEncoding("utf8")
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk
    emit({ type: "stderr", text: chunk })
  })

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => resolve(code))
  })

  if (stdoutBuffer.trim()) {
    for (const event of parseCodexExecJsonLine(stdoutBuffer)) emit(event)
  }
  emit({ type: "exit", code: exitCode })

  const result: CodexRunTurnResult = {
    vendor: "codex",
    argv,
    text: textParts.join(""),
    events,
    exitCode,
    stderr: stderr || stderrParts.join(""),
  }
  if (exitCode !== 0) {
    throw new CodexRunTurnError(`codex exec exited with code ${exitCode ?? "null"}`, result)
  }
  return result
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
