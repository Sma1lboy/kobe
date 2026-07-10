/**
 * Teardown layer of the tmux client — SIGTERM sweeps over pane process
 * groups and session kills. tmux teardown only delivers SIGHUP, which engine
 * CLIs (claude) and older kobe helpers catch without exiting — each killed
 * session/window then leaked its pane processes to launchd with a revoked
 * tty, burning CPU forever (#205 class; 2026-07-07 the un-swept closes had
 * accumulated 41 orphaned pane hosts, ~8.7GB, and pushed the machine into
 * OOM kills). SIGTERM is the signal those processes actually honour;
 * whatever ignores it still gets tmux's HUP right after. Internal to
 * `src/tmux/`; import via `./client.ts` from outside this directory.
 */

import { execSync } from "node:child_process"
import { runTmux, runTmuxCapturing, sessionExists } from "./client-spawn"
import { hiddenTerminalSessionName } from "./session-layout"

let cachedOwnPgid: number | null | undefined
/** Our own process group (pane_pid == pgid for tmux panes). */
function ownProcessGroup(): number | null {
  if (cachedOwnPgid !== undefined) return cachedOwnPgid
  try {
    const pgid = Number.parseInt(execSync(`ps -o pgid= -p ${process.pid}`).toString().trim(), 10)
    cachedOwnPgid = Number.isFinite(pgid) && pgid > 1 ? pgid : null
  } catch {
    cachedOwnPgid = null
  }
  return cachedOwnPgid
}

async function termPaneGroups(listPanesArgs: readonly string[]): Promise<void> {
  const { code, stdout } = await runTmuxCapturing(["list-panes", ...listPanesArgs, "-F", "#{pane_pid}"])
  if (code !== 0) return
  for (const line of stdout.split("\n")) {
    const pid = Number.parseInt(line.trim(), 10)
    if (!Number.isFinite(pid) || pid <= 1) continue
    // Never TERM the group we run inside: `kobe engine-tab-exit` fires from a
    // pane OF the window it closes (keepAlive onExit), and killing ourselves
    // here would abort before the kill-window ever runs. That pane's engine
    // has already exited (that's what triggered the cleanup), so skipping it
    // leaks nothing.
    if (pid === ownProcessGroup()) continue
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      // group already gone — nothing to reap
    }
  }
}

async function termSessionPaneGroups(name: string): Promise<void> {
  await termPaneGroups(["-s", "-t", `=${name}`])
}

/**
 * SIGTERM one window's pane groups — the pre-kill sweep for `kill-window`
 * paths (chat-tab close, engine-tab exit).
 */
export async function termWindowPaneGroups(windowId: string): Promise<void> {
  await termPaneGroups(["-t", windowId])
}

/** SIGTERM every pane group on the whole kobe server — `kill-sessions`' sweep. */
export async function termAllPaneGroups(): Promise<void> {
  await termPaneGroups(["-a"])
}

/** Kill a session (if any), sweeping its hidden helper session first. */
export async function killSession(name: string): Promise<void> {
  if (!name.startsWith("kobe-hidden-")) {
    const hidden = hiddenTerminalSessionName(name)
    if (await sessionExists(hidden)) {
      await termSessionPaneGroups(hidden)
      await runTmux(["kill-session", "-t", `=${hidden}`])
    }
  }
  if (await sessionExists(name)) {
    await termSessionPaneGroups(name)
    await runTmux(["kill-session", "-t", `=${name}`])
  }
}
