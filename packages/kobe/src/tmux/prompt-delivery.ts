/**
 * Deliver a prompt into a task's engine pane.
 *
 * Shared by `kobe api send`/`spawn-task` (an explicit, user-supplied
 * prompt) and the per-repo init prompt (the first prompt auto-delivered
 * when a session is freshly created — see state/repo-init.ts). Extracted
 * from api-cmd.ts so both paths use the same readiness wait + bracketed
 * paste instead of duplicating it.
 */

import type { FirstEngineMessage } from "../state/repo-init.ts"
import { capturePaneById, claudePaneId, claudePaneIdStrict, runTmux, sendKeyName } from "./client.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait until a session's engine pane exists and (for a freshly-built
 * session) has painted a stable prompt, so a paste lands in the composer
 * rather than mid-boot.
 *
 * `ready` is `false` when the budget is exhausted without confirmation —
 * the caller still delivers best-effort but surfaces that to the script,
 * so a cold-boot drop never looks like a clean success.
 */
export async function waitForEnginePane(session: string, fresh: boolean): Promise<{ pane: string; ready: boolean }> {
  let prev: string | null = null
  for (let attempt = 0; attempt < 24; attempt++) {
    const pane = await claudePaneIdStrict(session)
    if (pane) {
      if (!fresh) return { pane, ready: true }
      const cur = (await capturePaneById(pane)).trim()
      if (cur.length > 0 && cur === prev) return { pane, ready: true }
      prev = cur
    }
    await sleep(250)
  }
  // Budget exhausted: deliver to the tagged pane (or first-pane fallback
  // for a legacy/pre-tag session), but report the engine never confirmed.
  const pane = (await claudePaneIdStrict(session)) || (await claudePaneId(session))
  return { pane, ready: false }
}

/**
 * Type a (possibly multi-line) prompt into a pane and submit it.
 *
 * Uses a tmux paste buffer with bracketed-paste markers (`-p`) so an
 * interactive REPL receives the whole block as ONE paste. Plain
 * `send-keys -l` would type the bytes verbatim, and an embedded newline
 * is Enter to claude/codex — so a multi-paragraph prompt would submit at
 * the first line break. With bracketed paste the engine inserts the
 * entire block into its composer; a single trailing Enter then submits.
 */
export async function pasteAndSubmit(pane: string, text: string): Promise<void> {
  const buffer = `kobe-api-${pane.replace(/[^A-Za-z0-9]/g, "")}`
  await runTmux(["set-buffer", "-b", buffer, "--", text])
  await runTmux(["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane])
  await sendKeyName(pane, "Enter")
}

/**
 * Deliver a launch contract's first engine message into a freshly-built
 * session. Best-effort and fire-and-forget: it waits for the engine to be
 * ready (treating the session as fresh) and pastes. A missing pane is a
 * no-op — the user can still type — so this never throws into the caller.
 */
export async function deliverFirstEngineMessage(session: string, message: FirstEngineMessage): Promise<void> {
  const { pane } = await waitForEnginePane(session, true)
  if (!pane) return
  await pasteAndSubmit(pane, message.text)
}
