import { capMessages } from "./scrollback"
import type { ChatRow, ChatState } from "./store"

export interface PendingBashContext {
  readonly command: string
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number | null
}

export function pushBashRow(
  state: ChatState,
  args: { id: string; command: string },
  nowIso: string = new Date().toISOString(),
): ChatState {
  return {
    ...state,
    messages: capMessages(
      [
        ...state.messages,
        {
          kind: "bash",
          id: args.id,
          command: args.command,
          stdout: "",
          stderr: "",
          exitCode: null,
          signal: null,
          done: false,
          ts: nowIso,
        },
      ],
      nowIso,
    ),
  }
}

export function patchBashRow(
  state: ChatState,
  id: string,
  patch: {
    stdoutAppend?: string
    stderrAppend?: string
    exitCode?: number | null
    signal?: string | null
    done?: boolean
  },
): ChatState {
  const idx = findLastIndex(state.messages, (m) => m.kind === "bash" && m.id === id)
  if (idx < 0) return state
  const target = state.messages[idx] as Extract<ChatRow, { kind: "bash" }>
  const next = state.messages.slice()
  next[idx] = {
    ...target,
    stdout: patch.stdoutAppend ? target.stdout + patch.stdoutAppend : target.stdout,
    stderr: patch.stderrAppend ? target.stderr + patch.stderrAppend : target.stderr,
    exitCode: patch.exitCode !== undefined ? patch.exitCode : target.exitCode,
    signal: patch.signal !== undefined ? patch.signal : target.signal,
    done: patch.done !== undefined ? patch.done : target.done,
  }
  return { ...state, messages: next }
}

export function pushPendingBashContext(state: ChatState, ctx: PendingBashContext): ChatState {
  const prev = state.pendingBashContext ?? []
  return { ...state, pendingBashContext: [...prev, ctx] }
}

export function drainPendingBashContext(state: ChatState): [ChatState, readonly PendingBashContext[]] {
  const list = state.pendingBashContext ?? []
  if (list.length === 0) return [state, []]
  const { pendingBashContext: _drop, ...rest } = state
  void _drop
  return [{ ...rest }, list]
}

export function formatBashContextPrefix(entries: readonly PendingBashContext[]): string {
  if (entries.length === 0) return ""
  const parts: string[] = []
  for (const e of entries) {
    parts.push(`<bash-input>${escapeXml(e.command)}</bash-input>`)
    if (e.stdout.length > 0) parts.push(`<bash-stdout>${escapeXml(e.stdout)}</bash-stdout>`)
    if (e.stderr.length > 0) parts.push(`<bash-stderr>${escapeXml(e.stderr)}</bash-stderr>`)
  }
  parts.push("")
  return parts.join("\n")
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&amp;"
    if (c === "<") return "&lt;"
    if (c === ">") return "&gt;"
    if (c === '"') return "&quot;"
    return "&apos;"
  })
}

function findLastIndex<T>(arr: readonly T[], pred: (v: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i]
    if (v !== undefined && pred(v)) return i
  }
  return -1
}
