/**
 * Headless `claude -p` turn driver for the native chat pane (KOBE_TUI=1, exp).
 *
 * Spawn shape revived from the v0.5 driver (git 4e19a29f,
 * `claude-code-local/spawn.ts`, itself ported from opcode's `claude.rs`):
 * plain `child_process.spawn` — no PTY, stream-json is line-delimited JSON
 * over stdout, not terminal escapes. One subprocess PER TURN: the process
 * exits when the turn's `result` message lands, so no long-lived engine
 * process idles between prompts (the whole point of this backend vs the
 * tmux-hosted interactive CLI). The next prompt resumes the same
 * conversation via `--resume <session_id>`.
 *
 * Contract with the renderer: messages are the Agent SDK / stream-json
 * shapes VERBATIM — `SdkMessage` mirrors the wire fields (`message.content`
 * blocks, `session_id`, `usage`, `total_cost_usd`, …) and this module never
 * remaps them into a kobe-owned event union. The UI renders SDK fields
 * directly; that is a deliberate product decision, not laziness.
 */

import { spawn } from "node:child_process"

/** `content` blocks inside assistant/user messages — SDK field names verbatim. */
export interface SdkTextBlock {
  readonly type: "text"
  readonly text: string
}
export interface SdkThinkingBlock {
  readonly type: "thinking"
  readonly thinking: string
}
export interface SdkToolUseBlock {
  readonly type: "tool_use"
  readonly id: string
  readonly name: string
  readonly input: unknown
}
export interface SdkToolResultBlock {
  readonly type: "tool_result"
  readonly tool_use_id: string
  readonly content: unknown
  readonly is_error?: boolean
}
export type SdkContentBlock = SdkTextBlock | SdkThinkingBlock | SdkToolUseBlock | SdkToolResultBlock

/** Top-level stream-json messages — SDK field names verbatim. */
export interface SdkSystemMessage {
  readonly type: "system"
  readonly subtype?: string
  readonly session_id?: string
  readonly model?: string
}
export interface SdkAssistantMessage {
  readonly type: "assistant"
  readonly message: { readonly content: readonly SdkContentBlock[] }
  /** Set (non-null) on subagent events — nested under the parent Agent tool call. */
  readonly parent_tool_use_id?: string | null
  readonly session_id?: string
}
export interface SdkUserMessage {
  readonly type: "user"
  readonly message: { readonly content: readonly SdkContentBlock[] }
  readonly parent_tool_use_id?: string | null
}
export interface SdkResultMessage {
  readonly type: "result"
  readonly subtype: string
  readonly is_error?: boolean
  readonly result?: string
  readonly duration_ms?: number
  readonly total_cost_usd?: number
  readonly session_id?: string
  readonly usage?: {
    readonly input_tokens?: number
    readonly output_tokens?: number
    readonly cache_read_input_tokens?: number
    readonly cache_creation_input_tokens?: number
  }
}
export type SdkMessage = SdkSystemMessage | SdkAssistantMessage | SdkUserMessage | SdkResultMessage

const SDK_MESSAGE_TYPES = new Set(["system", "assistant", "user", "result"])

/**
 * Parse one stream-json line into an {@link SdkMessage}, or undefined for
 * blank lines / non-JSON noise / unknown top-level types (claude may add
 * new ones; dropping keeps a session alive across CLI upgrades). The parsed
 * object is returned AS-IS — fields the interfaces don't spell out are
 * still present on the value for future renderers.
 */
export function parseSdkLine(rawLine: string): SdkMessage | undefined {
  const line = rawLine.trim()
  if (!line) return undefined
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return undefined
  const type = (msg as { type?: unknown }).type
  if (typeof type !== "string" || !SDK_MESSAGE_TYPES.has(type)) return undefined
  return msg as SdkMessage
}

export interface HeadlessTurnOpts {
  /** Absolute path to the `claude` binary (from `findClaudeBinary`). */
  readonly binaryPath: string
  /** Working directory (the task's worktree root). */
  readonly cwd: string
  /** The user's prompt, passed via `-p`. */
  readonly prompt: string
  /** `--resume <sessionId>` — continue the previous turn's conversation. */
  readonly resumeSessionId?: string
  /** `--model <id>` — the composer's pinned model. Omit for claude's default. */
  readonly model?: string
  /** `--effort <level>` — model-bound reasoning effort, when the pick carries one. */
  readonly modelEffort?: string
  /**
   * `--permission-mode <mode>`. Headless `-p` cannot prompt interactively,
   * so a tool outside the mode's allowance is denied, not asked.
   * ponytail: fixed default from the host; a per-turn permission UI (SDK
   * canUseTool equivalent) is the upgrade path.
   */
  readonly permissionMode?: string
}

/** Build the canonical argv. Exposed for unit tests (arg order pinned). */
export function buildHeadlessArgs(
  opts: Pick<HeadlessTurnOpts, "prompt" | "resumeSessionId" | "permissionMode" | "model" | "modelEffort">,
): string[] {
  const args: string[] = []
  if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId)
  args.push("-p", opts.prompt)
  if (opts.model) args.push("--model", opts.model)
  if (opts.modelEffort) args.push("--effort", opts.modelEffort)
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode)
  args.push("--output-format", "stream-json", "--verbose")
  return args
}

export interface HeadlessTurn {
  /**
   * The turn's SDK messages, in wire order. Ends when the process closes
   * stdout (normally right after the terminal `result` message). Throws
   * only for spawn-level failures (ENOENT etc.) — in-turn errors arrive as
   * a `result` message with `is_error`, i.e. as SDK data.
   */
  readonly events: AsyncGenerator<SdkMessage, void>
  /** SIGTERM the process group (claude + its tool children). Idempotent. */
  interrupt(): void
}

/**
 * Spawn one `claude -p` turn. The child is its own process-group leader so
 * {@link HeadlessTurn.interrupt} can signal the whole tree (claude spawns
 * subagents and Bash children; a PID-only kill leaves them alive).
 */
export function startHeadlessTurn(opts: HeadlessTurnOpts): HeadlessTurn {
  const proc = spawn(opts.binaryPath, buildHeadlessArgs(opts), {
    cwd: opts.cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  })

  let interrupted = false
  const interrupt = (): void => {
    if (interrupted || proc.pid === undefined) return
    interrupted = true
    try {
      process.kill(-proc.pid, "SIGTERM")
    } catch {
      // Process group already gone — the turn ended on its own.
    }
  }

  async function* events(): AsyncGenerator<SdkMessage, void> {
    // Surface spawn failure (bad binary path) as a throw; stderr is folded
    // into the error so "claude exited without a result" is diagnosable.
    let spawnError: Error | undefined
    proc.once("error", (err) => {
      spawnError = err
    })
    let stderrTail = ""
    proc.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000)
    })

    let sawResult = false
    try {
      let buf = ""
      for await (const chunk of proc.stdout) {
        buf += typeof chunk === "string" ? chunk : chunk.toString("utf8")
        let nl = buf.indexOf("\n")
        while (nl !== -1) {
          const msg = parseSdkLine(buf.slice(0, nl))
          buf = buf.slice(nl + 1)
          nl = buf.indexOf("\n")
          if (msg) {
            if (msg.type === "result") sawResult = true
            yield msg
          }
        }
      }
      const last = parseSdkLine(buf)
      if (last) {
        if (last.type === "result") sawResult = true
        yield last
      }
    } finally {
      // Generator abandoned early (pane unmount) — don't leak the child.
      if (!sawResult) interrupt()
    }
    if (spawnError) throw spawnError
    if (!sawResult && !interrupted) {
      throw new Error(`claude exited without a result${stderrTail ? `: ${stderrTail.trim()}` : ""}`)
    }
  }

  return { events: events(), interrupt }
}
