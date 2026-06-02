/**
 * Auto-name every ChatTab window from its own first prompt (KOB).
 *
 * Companion to the daemon's live task auto-title (`daemon/auto-title-poller.ts`).
 * Each ChatTab is a tmux window running its own engine session; for a claude
 * launch we force a known session id at spawn (`--session-id`) and stash it on
 * the window as `@kobe_session_id` (see `tui/panes/terminal/tmux.ts`). This
 * pass walks every task's windows, reads that id, derives the window's first
 * user prompt from THAT transcript, and renames the window to it — so a
 * Ctrl+T tab gets its own name, not the task's.
 *
 * Per window:
 *   - Skip if it was named manually. `rename-window` (and F2) flips a window's
 *     `automatic-rename` to `off`; an untouched window inherits the global
 *     `on`. So `automatic-rename off` == "already named" — our don't-clobber
 *     guard. (The `#{automatic_rename}` FORMAT variable is empty on tmux 3.5a,
 *     so we query the option, not a format.)
 *   - With a recorded session id → name from that session (claude tabs).
 *   - Without one, only the ORIGIN (lowest-index) window is named, from the
 *     task's first session — the codex/legacy fallback, since codex can't take
 *     a caller-set session id and pre-change windows have no id stashed.
 *
 * Self-limiting like the title poller: once a window is renamed its
 * automatic-rename is off, so later ticks skip it; windows with no prompt yet
 * derive `""` and stay until their first message lands.
 *
 * Manual-rename persistence (origin window only): a user's F2 rename lives in
 * tmux and dies with the server. tmux can't tell our auto rename from a user's
 * (both flip `automatic-rename off`), so we stamp the name WE set as
 * `@kobe_auto_name`; a window that is named-off with a different `window_name`
 * was renamed by the user. We CAPTURE that into `Task.chatTabName` (durable in
 * tasks.json) and, after a server restart rebuilds the origin window fresh,
 * RESTORE it ahead of the auto-derive. Only the origin survives a rebuild, so
 * only it gets a stored name (keyed by the task); extra Ctrl+T tabs aren't
 * persisted and keep the pure auto-name behaviour.
 */

import { deriveTitleFromSession, deriveTitleFromSessionId } from "@/monitor/auto-title"
import type { Orchestrator } from "@/orchestrator/core"
import {
  CHAT_TAB_AUTO_NAME_OPTION,
  CHAT_TAB_SESSION_ID_OPTION,
  runTmux,
  runTmuxCapturing,
  tmuxSessionName,
} from "@/tmux/client"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"

/** Seam for tests — the real implementation shells `tmux` via the client. */
export interface TmuxRunner {
  capture(args: string[]): Promise<{ code: number; stdout: string }>
  run(args: string[]): Promise<number>
}

const realRunner: TmuxRunner = { capture: runTmuxCapturing, run: runTmux }

/** One ChatTab window: its tmux index, the engine session id, current name, and our last auto name. */
export interface ChatTabWindow {
  readonly index: number
  /** `@kobe_session_id` value, or `""` when none was recorded (codex/legacy). */
  readonly sessionId: string
  /** Current `#{window_name}` — what the status bar shows. */
  readonly name: string
  /** `@kobe_auto_name` — the name WE last auto-set, used to spot a user F2 rename. `""` when unset. */
  readonly autoName: string
}

/** List a session's windows with their session id, current name, and recorded auto name. `[]` when gone. */
export async function listChatTabWindows(session: string, runner: TmuxRunner = realRunner): Promise<ChatTabWindow[]> {
  const { code, stdout } = await runner.capture([
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    `#{window_index}\t#{${CHAT_TAB_SESSION_ID_OPTION}}\t#{window_name}\t#{${CHAT_TAB_AUTO_NAME_OPTION}}`,
  ])
  if (code !== 0) return []
  const out: ChatTabWindow[] = []
  for (const line of stdout.split("\n")) {
    const parts = line.split("\t")
    const index = Number.parseInt((parts[0] ?? "").trim(), 10)
    if (!Number.isInteger(index)) continue
    out.push({ index, sessionId: (parts[1] ?? "").trim(), name: parts[2] ?? "", autoName: parts[3] ?? "" })
  }
  return out
}

/** True when a window was named manually (F2 / `-n`): its automatic-rename is off. */
async function windowNamedManually(session: string, index: number, runner: TmuxRunner): Promise<boolean> {
  const { code, stdout } = await runner.capture([
    "show-window-options",
    "-t",
    `=${session}:${index}`,
    "automatic-rename",
  ])
  return code === 0 && /\boff\b/.test(stdout)
}

/**
 * Rename one window. Returns true on success. When `stampAuto`, also record the
 * name as `@kobe_auto_name` so a later pass can tell this auto name apart from a
 * user's F2 rename. A RESTORE of a stored manual name passes `stampAuto: false`
 * (it isn't our auto name), so the option stays unset and the capture branch
 * leaves it alone.
 */
async function renameWindow(
  session: string,
  index: number,
  title: string,
  runner: TmuxRunner,
  stampAuto = false,
): Promise<boolean> {
  const ok = (await runner.run(["rename-window", "-t", `=${session}:${index}`, "--", title])) === 0
  if (ok && stampAuto) {
    await runner.run(["set-window-option", "-t", `=${session}:${index}`, CHAT_TAB_AUTO_NAME_OPTION, title])
  }
  return ok
}

/** Injectable title derivers so the pass is testable without disk transcripts. */
export interface ChatTabNamingDeps {
  runner: TmuxRunner
  titleFromSessionId(vendor: VendorId, sessionId: string): Promise<string>
  titleFromWorktree(worktree: string, vendor: VendorId): Promise<string>
}

const realDeps: ChatTabNamingDeps = {
  runner: realRunner,
  titleFromSessionId: deriveTitleFromSessionId,
  titleFromWorktree: deriveTitleFromSession,
}

/**
 * One pass: name every still-default ChatTab window across all tasks. Returns
 * the number of windows renamed (for tests). Best-effort per window — a tmux
 * or read failure on one window never blocks the others.
 */
export async function runChatTabNamingPass(orch: Orchestrator, deps: ChatTabNamingDeps = realDeps): Promise<number> {
  let renamed = 0
  for (const task of orch.listTasks()) {
    if (task.kind === "main" || !task.worktreePath) continue
    const session = tmuxSessionName(task.id)
    const windows = await listChatTabWindows(session, deps.runner)
    if (windows.length === 0) continue
    const originIndex = windows.reduce((min, w) => Math.min(min, w.index), Number.POSITIVE_INFINITY)
    const vendor = task.vendor ?? DEFAULT_TASK_VENDOR
    const storedName = (task.chatTabName ?? "").trim()
    for (const w of windows) {
      try {
        const namedManually = await windowNamedManually(session, w.index, deps.runner)
        const isOrigin = w.index === originIndex

        // ORIGIN window: durable manual-name handling. Only the origin survives
        // a tmux server restart (extra Ctrl+T tabs aren't rebuilt), so it's the
        // only window whose user rename we persist (keyed by the task) and
        // restore.
        if (isOrigin) {
          if (!namedManually) {
            // automatic-rename is ON → the window is unnamed/default this
            // session. A stored manual name means the server was restarted and
            // the window reverted: RESTORE it (wins over auto-derive). Don't
            // stamp @kobe_auto_name — this is the user's name, not ours.
            if (storedName) {
              if (await renameWindow(session, w.index, storedName, deps.runner)) renamed++
              continue
            }
            // else: no override yet → fall through to auto-derive below.
          } else {
            // automatic-rename is OFF → something named it. Tell our own auto
            // name (@kobe_auto_name) apart from a user's F2 rename and CAPTURE
            // the latter so it survives a future restart. (A legacy window with
            // no @kobe_auto_name over-captures its stable first-prompt title —
            // benign.)
            const userNamed = w.name.length > 0 && w.name !== w.autoName
            if (userNamed && w.name !== storedName) await orch.setChatTabName(task.id, w.name)
            continue
          }
        } else if (namedManually) {
          continue
        }

        // Auto-derive: the origin without a stored override, or any non-origin
        // window. Stamp @kobe_auto_name so the next pass won't mistake it for a
        // user rename.
        const title = w.sessionId
          ? await deps.titleFromSessionId(vendor, w.sessionId)
          : isOrigin
            ? await deps.titleFromWorktree(task.worktreePath, vendor)
            : ""
        if (title && (await renameWindow(session, w.index, title, deps.runner, true))) renamed++
      } catch {
        // best-effort: skip this window, keep going
      }
    }
  }
  return renamed
}
