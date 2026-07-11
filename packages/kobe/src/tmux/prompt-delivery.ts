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
import { capturePaneById, claudePaneIdStrict, runTmux, sendKeyName } from "./client.ts"
import { REPO_INIT_TIMEOUT_SECONDS } from "./launch-line.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll interval while waiting for a fresh session's engine pane to settle. */
const POLL_INTERVAL_MS = 250

/**
 * Readiness budget for a fresh session whose worktree runs NO init script:
 * the engine paints its prompt in a couple of seconds, so a short budget
 * keeps `send`/`fan-out` snappy.
 */
export const FRESH_PANE_BUDGET_SECONDS = 6

/**
 * Delay between the bracketed paste and the submit Enter so they land as
 * separate tty reads. Matches the web composer + sidecar `/pty/send` fix
 * (CHANGELOG 8f6dd64); see {@link pasteAndSubmit}.
 */
const SUBMIT_DELAY_MS = 150

/** Trailing slice of the prompt compared against the composer after a paste. */
const VERIFY_TAIL_CHARS = 24

/**
 * Wait until a session's engine pane exists and (for a freshly-built
 * session) has painted a stable prompt, so a paste lands in the composer
 * rather than mid-boot.
 *
 * `budgetSeconds` bounds the fresh-session wait. It must cover the worst
 * case that delays the engine's first paint: a repo `.kobe/init.sh` that
 * runs BEFORE the engine, whose own watchdog is {@link
 * REPO_INIT_TIMEOUT_SECONDS} (~120s). A `send`/`fan-out` into a
 * no-init-script worktree passes the short {@link FRESH_PANE_BUDGET_SECONDS}
 * so it stays snappy. Ignored for a reused session (`fresh=false`), which
 * returns as soon as the tagged pane is found.
 *
 * The pane is looked up STRICTLY (`@kobe_role=claude`), never falling back
 * to "first pane": an untagged first pane is a shell/ops pane, not the
 * engine, and blind-pasting a prompt there is worse than reporting failure.
 * `pane` is `""` (and `ready` false) when the budget runs out without a
 * tagged engine pane — the caller must treat that as a delivery failure.
 */
export async function waitForEnginePane(
  session: string,
  fresh: boolean,
  budgetSeconds = FRESH_PANE_BUDGET_SECONDS,
): Promise<{ pane: string; ready: boolean }> {
  const deadline = Date.now() + budgetSeconds * 1000
  let prev: string | null = null
  let lastPane = ""
  // Always poll at least once, then until the wall-clock budget is spent.
  do {
    const pane = await claudePaneIdStrict(session)
    if (pane) {
      lastPane = pane
      if (!fresh) return { pane, ready: true }
      const cur = (await capturePaneById(pane)).trim()
      if (cur.length > 0 && cur === prev) return { pane, ready: true }
      prev = cur
    }
    await sleep(POLL_INTERVAL_MS)
  } while (Date.now() < deadline)
  // Budget exhausted. Return the tagged pane if one appeared (deliver
  // best-effort but report engineReady:false) — but NEVER a first-pane
  // guess: a blind paste into an untagged pane derails a shell or the
  // wrong task. No tagged pane ⇒ pane:"" ⇒ the caller fails the delivery.
  return { pane: lastPane, ready: false }
}

/**
 * Type a (possibly multi-line) prompt into a pane and submit it, then
 * verify the paste actually landed in the composer.
 *
 * Uses a tmux paste buffer with bracketed-paste markers (`-p`) so an
 * interactive REPL receives the whole block as ONE paste. Plain
 * `send-keys -l` would type the bytes verbatim, and an embedded newline
 * is Enter to claude/codex — so a multi-paragraph prompt would submit at
 * the first line break. With bracketed paste the engine inserts the
 * entire block into its composer; a single trailing Enter then submits.
 *
 * Returns whether the paste was confirmed: after pasting (but BEFORE the
 * submit Enter) we capture the pane and check the prompt's own tail is
 * present. Comparing our OWN pasted text keeps this vendor-neutral (no
 * claude/codex-specific composer parsing). `false` means the paste didn't
 * take — the caller surfaces it instead of reporting a phantom success.
 */
export async function pasteAndSubmit(pane: string, text: string): Promise<boolean> {
  const buffer = `kobe-api-${pane.replace(/[^A-Za-z0-9]/g, "")}`
  await runTmux(["set-buffer", "-b", buffer, "--", text])
  await runTmux(["paste-buffer", "-p", "-d", "-b", buffer, "-t", pane])
  // Defer the submit Enter so it lands as a SEPARATE tty read from the
  // bracketed paste. Written back-to-back, the paste's `\e[201~` end-marker
  // and the `\r` can coalesce into one read and the engine treats the
  // carriage return as paste content — the prompt then sits unsent in the
  // composer. The web composer + sidecar `/pty/send` path already split these
  // (CHANGELOG 8f6dd64); this is the tmux delivery twin.
  await sleep(SUBMIT_DELAY_MS)
  const landed = await pasteLanded(pane, text)
  await sendKeyName(pane, "Enter")
  return landed
}

/**
 * Confirm a just-pasted prompt is sitting in the pane's composer by
 * checking the prompt's own trailing characters appear in the capture.
 * We compare our OWN text (not any vendor UI string), so it works for
 * every engine. A single-line prompt's tail is exact; a multi-line
 * prompt's LAST non-empty line is used, since bracketed paste keeps line
 * breaks and tmux's capture is line-oriented.
 */
async function pasteLanded(pane: string, text: string): Promise<boolean> {
  const lines = text.split("\n").filter((l) => l.trim().length > 0)
  const lastLine = lines[lines.length - 1] ?? text
  const needle = lastLine.trim().slice(-VERIFY_TAIL_CHARS)
  if (!needle) return true // nothing meaningful to verify (blank prompt)
  const captured = await capturePaneById(pane)
  return captured.includes(needle)
}

/**
 * Deliver a launch contract's first engine message into a freshly-built
 * session. Best-effort: it waits for the engine to be ready (treating the
 * session as fresh, with the full init-script budget since a repo that
 * ships an init prompt usually ships an init script too) and pastes.
 *
 * Returns whether the message was DELIVERED: `false` when no engine pane
 * appeared in budget or the paste didn't land in the composer. The caller
 * (fresh-session create + `kobe api` first prompt) surfaces `false` so a
 * fan-out's first prompt silently dropping on a cold boot never looks like
 * a clean success. A missing pane never throws — the user can still type.
 */
export async function deliverFirstEngineMessage(session: string, message: FirstEngineMessage): Promise<boolean> {
  const { pane } = await waitForEnginePane(session, true, REPO_INIT_TIMEOUT_SECONDS)
  if (!pane) return false
  return pasteAndSubmit(pane, message.text)
}
