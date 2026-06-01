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
 */

import { deriveTitleFromSession, deriveTitleFromSessionId } from "@/monitor/auto-title"
import type { Orchestrator } from "@/orchestrator/core"
import { CHAT_TAB_SESSION_ID_OPTION, runTmux, runTmuxCapturing, tmuxSessionName } from "@/tmux/client"
import { DEFAULT_TASK_VENDOR, type VendorId } from "@/types/task"

/** Seam for tests — the real implementation shells `tmux` via the client. */
export interface TmuxRunner {
  capture(args: string[]): Promise<{ code: number; stdout: string }>
  run(args: string[]): Promise<number>
}

const realRunner: TmuxRunner = { capture: runTmuxCapturing, run: runTmux }

/** One ChatTab window: its tmux index and the engine session id stashed on it. */
export interface ChatTabWindow {
  readonly index: number
  /** `@kobe_session_id` value, or `""` when none was recorded (codex/legacy). */
  readonly sessionId: string
}

/** List a session's windows with their recorded engine session id. `[]` when the session is gone. */
export async function listChatTabWindows(session: string, runner: TmuxRunner = realRunner): Promise<ChatTabWindow[]> {
  const { code, stdout } = await runner.capture([
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    `#{window_index}\t#{${CHAT_TAB_SESSION_ID_OPTION}}`,
  ])
  if (code !== 0) return []
  const out: ChatTabWindow[] = []
  for (const line of stdout.split("\n")) {
    const tab = line.indexOf("\t")
    const index = Number.parseInt((tab >= 0 ? line.slice(0, tab) : line).trim(), 10)
    if (!Number.isInteger(index)) continue
    out.push({ index, sessionId: tab >= 0 ? line.slice(tab + 1).trim() : "" })
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

/** Rename one window. Returns true on success. */
async function renameWindow(session: string, index: number, title: string, runner: TmuxRunner): Promise<boolean> {
  return (await runner.run(["rename-window", "-t", `=${session}:${index}`, "--", title])) === 0
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
    for (const w of windows) {
      try {
        if (await windowNamedManually(session, w.index, deps.runner)) continue
        const title = w.sessionId
          ? await deps.titleFromSessionId(vendor, w.sessionId)
          : w.index === originIndex
            ? await deps.titleFromWorktree(task.worktreePath, vendor)
            : ""
        if (title && (await renameWindow(session, w.index, title, deps.runner))) renamed++
      } catch {
        // best-effort: skip this window, keep going
      }
    }
  }
  return renamed
}
