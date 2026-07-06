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
 *     guard. The flag rides the window listing as the `#{automatic-rename}`
 *     OPTION-name format (hyphen — the `#{automatic_rename}` underscore
 *     variable doesn't exist and expands empty on tmux 3.5a), which resolves
 *     "1"/"0" through option inheritance; only the global-off corner needs a
 *     real `show-window-options` probe (see `runChatTabNamingPass`).
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
  /**
   * The window's EFFECTIVE `automatic-rename` as the `#{automatic-rename}`
   * format flag: `"1"` on, `"0"` off, `""` when the tmux can't expand
   * option names in formats. tmux resolves the flag through option
   * inheritance (local window value, else the global window option), so
   * `"1"` PROVES the local option isn't `off` (i.e. the window was never
   * manually named) without a per-window `show-window-options` spawn;
   * `"0"` is ambiguous when the user's tmux.conf sets the GLOBAL
   * automatic-rename off — the pass disambiguates with one global probe.
   */
  readonly autoRename: string
}

/** List a session's windows with their recorded engine session id. `[]` when the session is gone. */
export async function listChatTabWindows(session: string, runner: TmuxRunner = realRunner): Promise<ChatTabWindow[]> {
  const { code, stdout } = await runner.capture([
    "list-windows",
    "-t",
    `=${session}`,
    "-F",
    `#{window_index}\t#{automatic-rename}\t#{${CHAT_TAB_SESSION_ID_OPTION}}`,
  ])
  if (code !== 0) return []
  const out: ChatTabWindow[] = []
  for (const line of stdout.split("\n")) {
    const [indexField, autoRename, sessionId] = line.split("\t")
    const index = Number.parseInt((indexField ?? "").trim(), 10)
    if (!Number.isInteger(index)) continue
    out.push({ index, sessionId: sessionId?.trim() ?? "", autoRename: autoRename?.trim() ?? "" })
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

/** True when the user's GLOBAL window automatic-rename is off (tmux.conf). */
async function globalAutomaticRenameOff(runner: TmuxRunner): Promise<boolean> {
  const { code, stdout } = await runner.capture(["show-window-options", "-g", "automatic-rename"])
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
  // Manual-name guard, mostly free of tmux spawns. The flag carried by the
  // window listing already proves "never manually named" when it reads on
  // (`"1"`); a `"0"` only needs the per-window `show-window-options` probe
  // when the GLOBAL automatic-rename is off (then every window expands `"0"`
  // and the flag can't tell local-off from inherited-off). The global state
  // is probed lazily, at most ONCE per pass — so the steady state (all
  // windows named, global on) costs one list-windows per task and zero
  // per-window probes.
  let globalOff: boolean | null = null
  const manuallyNamed = async (session: string, w: ChatTabWindow): Promise<boolean> => {
    if (w.autoRename === "1") return false
    if (w.autoRename === "0") {
      if (globalOff === null) globalOff = await globalAutomaticRenameOff(deps.runner)
      if (!globalOff) return true
    }
    // Ambiguous (global off) or unexpandable flag — ask the window directly.
    return windowNamedManually(session, w.index, deps.runner)
  }
  for (const task of orch.listTasks()) {
    // Archived tasks are settled — skip before the per-task `tmux list-windows`
    // shell-out + transcript reads, which otherwise ran every tick for every
    // archived task and scaled with the archive size. Un-archiving re-includes
    // the task on the next tick. Matches the sidebar's `t.archived` predicate.
    if (task.archived || task.kind === "main" || !task.worktreePath) continue
    const session = tmuxSessionName(task.id)
    const windows = await listChatTabWindows(session, deps.runner)
    if (windows.length === 0) continue
    const originIndex = windows.reduce((min, w) => Math.min(min, w.index), Number.POSITIVE_INFINITY)
    const vendor = task.vendor ?? DEFAULT_TASK_VENDOR
    for (const w of windows) {
      try {
        if (await manuallyNamed(session, w)) continue
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
