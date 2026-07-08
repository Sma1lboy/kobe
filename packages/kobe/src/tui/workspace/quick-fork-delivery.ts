/**
 * Quick-fork first-prompt delivery (issue #17, phase 2) — deliver the
 * composer's prompt into a freshly-created task's first engine tab once
 * its PTY is actually ready, instead of the tmux world's pane-capture
 * poll (`tmux/prompt-delivery.ts`). "Ready" here means the PTY has
 * produced its FIRST output chunk (the engine banner painting) — before
 * that the shell is mid-spawn and a paste would race the engine's own
 * bootstrap input.
 *
 * Framework-free (no React/opentui): the caller supplies an already-
 * acquired `TaskPtyLike` handle, so this module only owns the
 * subscribe-once/timeout-fallback decision, testable against
 * `pty-mock.ts`'s `MockTaskPty` (or any fake with the same shape).
 */

import type { TaskPtyLike } from "../panes/terminal/pty-types"

/** Budget for the engine to produce its first output chunk. */
export const READY_TIMEOUT_MS = 5000

/** Poll cadence while waiting for the tab's PTY to be acquired (registry.acquire()
 *  runs in a CHILD component's mount effect, so it isn't guaranteed to exist yet
 *  when the tab list mounts — see Terminal.tsx's geometry-gated acquire effect). */
const ACQUIRE_POLL_MS = 50

export interface DeliverInitialPromptResult {
  /** True when the prompt was pasted + submitted; false on timeout. */
  readonly delivered: boolean
}

/**
 * Subscribe to `pty`'s output; on the FIRST chunk (which may fire
 * synchronously if the pty already has a snapshot — `onData`'s replay
 * contract, see `pty-xterm-base.ts`), unsubscribe and paste+submit the
 * prompt the same way `sendToEngineFn` does (`pty.paste(text); pty.write("\r")`).
 * If no output arrives within `timeoutMs`, resolves `{ delivered: false }`
 * instead of silently swallowing the prompt — the caller surfaces that to
 * the user.
 */
export function deliverInitialPrompt(
  pty: TaskPtyLike,
  prompt: string,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<DeliverInitialPromptResult> {
  return new Promise((resolve) => {
    let settled = false
    let unsubscribeData: (() => void) | null = null
    let unsubscribeExit: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    function settle(delivered: boolean): void {
      if (settled) return
      settled = true
      if (timer !== null) clearTimeout(timer)
      unsubscribeData?.()
      unsubscribeExit?.()
      resolve({ delivered })
    }

    // Dead on arrival (e.g. the engine binary is missing) — never deliver
    // into a shell that already exited.
    unsubscribeExit = pty.onExit(() => settle(false))
    if (pty.killed) return

    unsubscribeData = pty.onData(() => {
      if (settled) return
      pty.paste(prompt)
      pty.write("\r")
      settle(true)
    })

    timer = setTimeout(() => settle(false), timeoutMs)
  })
}

/**
 * Wait for `getPty()` to return a live handle, then deliver. Shares one
 * `timeoutMs` budget across both the acquire-wait and the readiness-wait,
 * so a slow/never-acquired PTY still surfaces the same timeout fallback
 * as a PTY that acquires but never produces output. `signal` lets a
 * React mount-once effect cancel the poll on unmount without leaking a
 * `setTimeout` chain past teardown.
 */
export function waitAndDeliverInitialPrompt(
  getPty: () => TaskPtyLike | null,
  prompt: string,
  timeoutMs: number = READY_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<DeliverInitialPromptResult> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    function poll(): void {
      if (signal?.aborted) {
        resolve({ delivered: false })
        return
      }
      const pty = getPty()
      if (pty) {
        resolve(deliverInitialPrompt(pty, prompt, Math.max(0, deadline - Date.now())))
        return
      }
      if (Date.now() >= deadline) {
        resolve({ delivered: false })
        return
      }
      setTimeout(poll, ACQUIRE_POLL_MS)
    }
    poll()
  })
}
