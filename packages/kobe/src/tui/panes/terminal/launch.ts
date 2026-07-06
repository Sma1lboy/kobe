/**
 * Shared launch-line helpers for kobe-owned tmux panes.
 *
 * Every pane command kobe hands to tmux (`new-session` / `split-window` /
 * `respawn-pane` / `run-shell`) is a single `sh -c` string, and the three
 * builders of those strings — the `ensureSession` applier (`tmux.ts`), the
 * ChatTab lifecycle (`chattab.ts`), and the pane-heal machinery
 * (`pane-heal.ts`) — all need the same two pieces:
 *
 *   - {@link inheritedEnvPrefix} pins kobe's env onto the inner command, and
 *   - {@link wrapEngineLaunch} re-wraps an engine command over SSH for a
 *     remote task ({@link REMOTE_KEY_OPTION} carries the project key on the
 *     session).
 *
 * They live here — not in `tmux.ts` — because `tmux.ts` re-exports the
 * sibling modules; helpers shared across all three must sit below that
 * re-export surface to keep the import graph acyclic.
 */

import { execHostForRepo } from "@/exec/resolve"
import { shellQuote } from "@/tmux/session-layout"

/** Session tag carrying a remote project's key (`ssh://…`) so chat tabs + the
 * vendor-switch respawn re-wrap the engine over SSH. Absent for local tasks. */
export const REMOTE_KEY_OPTION = "@kobe_remote"

/**
 * Wrap a built engine command for the host the task's project resolves to:
 * a remote project's host wraps it over the multiplexed SSH connection
 * (`ssh -tt … 'cd <remoteWt> && <engine>'`); the local host's `wrapCommand`
 * is the identity (no `remoteKey`, or an `ssh://` key with no stored config,
 * which resolves local). `ensureReady` opens the ControlMaster once so the
 * pane's ssh reuses it with no re-auth (no secret in the pane command). See
 * `docs/design/remote-projects.md`.
 */
export function wrapEngineLaunch(engineCmd: string, remoteKey: string | undefined, remoteCwd: string): string {
  if (!remoteKey) return engineCmd
  const host = execHostForRepo(remoteKey)
  host.ensureReady()
  return host.wrapCommand(engineCmd, { tty: true, cwd: remoteCwd })
}

/**
 * Shell `KEY='val' …` prefix that pins kobe's env onto an inner pane's
 * command so the pane uses the SAME home dir / daemon / tmux server as
 * the outer monitor that created it — independent of tmux-server env
 * inheritance, which goes stale when a server persists across outer
 * restarts. Without this the Tasks pane could read the PRODUCTION
 * `~/.kobe/tasks.json` (KOBE_HOME_DIR missing) or connect to a dead
 * daemon (KOBE_DAEMON_SOCKET_PATH stale) → its task list / clicks
 * desynced from the outer monitor.
 */
export function inheritedEnvPrefix(): string {
  const parts: string[] = []
  for (const key of ["KOBE_HOME_DIR", "KOBE_DAEMON_SOCKET_PATH", "KOBE_TMUX_SOCKET"]) {
    const value = process.env[key]
    if (value && value.length > 0) parts.push(`${key}=${shellQuote(value)}`)
  }
  return parts.length > 0 ? `${parts.join(" ")} ` : ""
}
