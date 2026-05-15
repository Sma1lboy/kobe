import { type Accessor, createMemo, onCleanup } from "solid-js"
import { runBashCommand } from "./bash-mode"
import { stringifyErr } from "./chat-utils"
import type { ChatState } from "./row-types"
import {
  QUEUE_SOFT_CAP,
  drainPendingBashContext,
  enqueueBashCommand,
  formatBashContextPrefix,
  patchBashRow,
  pushBashRow,
  pushPendingBashContext,
  pushSystemError,
  queueIsFull,
} from "./store"

type PatchState = (fn: (state: ChatState) => ChatState) => void
type PatchStateForTab = (tabId: string, fn: (state: ChatState) => ChatState) => void

export function useBashMode(opts: {
  readonly taskId: Accessor<string | undefined>
  readonly activeTabId: Accessor<string | null>
  readonly activeState: Accessor<ChatState>
  readonly worktreePath: Accessor<string | undefined>
  readonly patchActiveState: PatchState
  readonly patchStateForTab: PatchStateForTab
}) {
  const bashAbortsByTab = new Map<string, AbortController>()

  onCleanup(() => {
    for (const ac of bashAbortsByTab.values()) ac.abort()
    bashAbortsByTab.clear()
  })

  function abortTab(tabId: string): void {
    bashAbortsByTab.get(tabId)?.abort()
  }

  function handleBashCommand(command: string): void {
    if (opts.activeState().isStreaming) {
      if (!opts.activeTabId()) return
      if (queueIsFull(opts.activeState())) {
        opts.patchActiveState((s) => pushSystemError(s, `queue is full (max ${QUEUE_SOFT_CAP})`))
        return
      }
      opts.patchActiveState((s) => enqueueBashCommand(s, command))
      return
    }
    void runBashLocally(command)
  }

  async function runBashLocally(command: string): Promise<void> {
    const taskId = opts.taskId()
    const tabId = opts.activeTabId()
    if (!taskId || !tabId) return
    const cwd = opts.worktreePath()
    if (!cwd) {
      opts.patchStateForTab(tabId, (s) => pushSystemError(s, "bash: task has no worktree yet"))
      return
    }

    bashAbortsByTab.get(tabId)?.abort()
    const ac = new AbortController()
    bashAbortsByTab.set(tabId, ac)

    const id = `bash-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
    opts.patchStateForTab(tabId, (s) => pushBashRow(s, { id, command }))

    let stdoutAcc = ""
    let stderrAcc = ""
    try {
      const result = await runBashCommand({
        command,
        cwd,
        onStdout: (chunk) => {
          stdoutAcc += chunk
          opts.patchStateForTab(tabId, (s) => patchBashRow(s, id, { stdoutAppend: chunk }))
        },
        onStderr: (chunk) => {
          stderrAcc += chunk
          opts.patchStateForTab(tabId, (s) => patchBashRow(s, id, { stderrAppend: chunk }))
        },
        signal: ac.signal,
      })
      opts.patchStateForTab(tabId, (s) =>
        patchBashRow(s, id, { done: true, exitCode: result.exitCode, signal: result.signal }),
      )
      if (!ac.signal.aborted) {
        opts.patchStateForTab(tabId, (s) =>
          pushPendingBashContext(s, {
            command,
            stdout: stdoutAcc,
            stderr: stderrAcc,
            exitCode: result.exitCode,
          }),
        )
      }
    } catch (err) {
      opts.patchStateForTab(tabId, (s) => patchBashRow(s, id, { done: true, exitCode: -1, signal: null }))
      opts.patchStateForTab(tabId, (s) => pushSystemError(s, `bash failed: ${stringifyErr(err)}`))
    } finally {
      if (bashAbortsByTab.get(tabId) === ac) bashAbortsByTab.delete(tabId)
    }
  }

  function drainBashContextPrefix(): string {
    const ctxs = opts.activeState().pendingBashContext ?? []
    if (ctxs.length === 0) return ""
    const prefix = formatBashContextPrefix(ctxs)
    opts.patchActiveState((s) => {
      const [next] = drainPendingBashContext(s)
      return next
    })
    return prefix
  }

  const hasActiveBash = createMemo(() => {
    const msgs = opts.activeState().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (!m) continue
      if (m.kind === "bash") return !m.done
    }
    return false
  })

  return { abortTab, handleBashCommand, runBashLocally, drainBashContextPrefix, hasActiveBash }
}
