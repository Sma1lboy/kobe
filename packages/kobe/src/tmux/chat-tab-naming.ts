/**
 * Auto-name a task's first ChatTab window (KOB).
 *
 * Companion to the daemon's live task auto-title (`daemon/auto-title-poller.ts`):
 * when a task is named from its first prompt, we also rename the task's
 * ORIGIN ChatTab window (the first tmux window of its session) to the same
 * title, so the tab strip stops reading `claude` / `zsh`. Scope is
 * deliberately the first tab only — additional Ctrl+T tabs keep tmux's
 * default name.
 *
 * Two tmux facts this leans on (verified on tmux 3.5a):
 *   - The origin window is NOT index 0. kobe runs with `base-index 1`, so
 *     the first `new-session` window is index 1 and any `:0` target fails.
 *     We list windows and take the lowest index — the origin ChatTab is
 *     created first (at `new-session`); Ctrl+T tabs and the special
 *     settings/new-task/update windows are all appended at higher indices.
 *   - `rename-window` flips that window's `automatic-rename` to `off` and
 *     the name sticks (this is also why F2 rename sticks). So an untouched
 *     origin window inherits the global `automatic-rename on`, while a
 *     window someone already named (F2, or a prior run) reads `off`. We use
 *     that as the "don't clobber a manual rename" guard — the
 *     `#{automatic_rename}` FORMAT variable is empty on 3.5a, so we query
 *     the option instead.
 */

import { runTmux, runTmuxCapturing, tmuxSessionName } from "./client.ts"

/** Seam for tests — the real implementation shells `tmux` via the client. */
export interface TmuxRunner {
  capture(args: string[]): Promise<{ code: number; stdout: string }>
  run(args: string[]): Promise<number>
}

const realRunner: TmuxRunner = { capture: runTmuxCapturing, run: runTmux }

/**
 * Rename the origin ChatTab window of `taskId`'s session to `title`.
 * Returns true if a rename was issued. No-ops (returns false) when the
 * session is gone, has no windows, or the origin window was already named
 * manually. Best-effort: never throws — a tmux failure just returns false.
 */
export async function renameOriginChatTab(
  taskId: string,
  title: string,
  runner: TmuxRunner = realRunner,
): Promise<boolean> {
  const trimmed = title.trim()
  if (!trimmed) return false
  const session = tmuxSessionName(taskId)
  try {
    const list = await runner.capture(["list-windows", "-t", `=${session}`, "-F", "#{window_index}"])
    if (list.code !== 0) return false
    const origin = list.stdout
      .split("\n")
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b)[0]
    if (origin === undefined) return false
    const target = `=${session}:${origin}`
    // Skip a window someone already named (F2 sets automatic-rename off).
    const opt = await runner.capture(["show-window-options", "-t", target, "automatic-rename"])
    if (opt.code === 0 && /\boff\b/.test(opt.stdout)) return false
    return (await runner.run(["rename-window", "-t", target, "--", trimmed])) === 0
  } catch {
    return false
  }
}
