/**
 * The kobe-home fallback session — where a client lands when its task is
 * deleted/archived with no other task preferred, and where `kobe` parks when
 * launched with zero tasks. Internal to `src/tmux/`; import via `./client.ts`
 * from outside this directory.
 */

import { kobeCliInvocation } from "@/cli/invocation"
// `inheritedEnvPrefix` lives in the `panes/terminal/launch` helper module. That
// module's only deps are `@/exec/resolve` + `@/tmux/session-layout`, neither of
// which imports this file, so the reference is acyclic at runtime even though it
// reaches "up" into the tui layer — the import is for the kobe-home Tasks pane's
// env pinning below. Keeping the prefix in one place avoids re-deriving
// the same KOBE_*-pinning logic the workspace panes already use.
import { inheritedEnvPrefix } from "@/tui/panes/terminal/launch"
import { PANE_ROLE_OPTION, getSessionOption, globalTasksPaneWidth, setSessionOption } from "./client-options"
import {
  SAFE_SPAWN_CWD,
  currentSessionName,
  runTmux,
  runTmuxCapturing,
  runTmuxSequence,
  sessionExists,
} from "./client-spawn"
import { homeWelcomeCommand, keepAlive, tasksPaneCommand } from "./session-layout"

/** Session name for the kobe home window shown when a task is archived/deleted. */
export const KOBE_HOME_SESSION = "kobe-home"

/** Session option tagging a kobe-home built as the full Tasks home. */
const HOME_KIND_OPTION = "@kobe_home"

/**
 * Ensure the kobe-home session exists and return its name.
 *
 * kobe-home is where a client lands when the task it was attached to is
 * deleted/archived with no other task preferred ({@link switchClientBeforeKill}),
 * and where `kobe` parks when launched with zero tasks. It runs the same
 * full-width Tasks pane (`kobe tasks`) a real task session uses for its
 * sidebar, so the user can create (`n`) or pick a task and switch straight
 * into it — instead of being stranded on a dead-end placeholder shell (the
 * pre-fix behaviour: a bare `sh` printing "No active task").
 *
 * It keeps the product's layout frame: a welcome "no task" main pane with
 * the same fixed-width Tasks rail a real session carries on its left,
 * focused so `n`/arrows work immediately. The other task-bound panes
 * (engine chat, file tree, Ops) are omitted — they have no worktree/engine
 * to populate until a task is entered.
 *
 * cwd is anchored to {@link SAFE_SPAWN_CWD} (no worktree exists here); both
 * panes keep-alive so a returning command drops to a shell instead of
 * collapsing the window. A legacy placeholder home (missing the
 * `@kobe_home` tag) is rebuilt in place — tmux sessions outlive a kobe
 * relaunch, so a stale bare-shell home from an older build is upgraded
 * rather than silently reused. Safe to rebuild: this is only called before
 * switching a client ONTO home, never while one is parked on it.
 */
export async function ensureFallbackSession(): Promise<string> {
  const name = KOBE_HOME_SESSION
  if (await sessionExists(name)) {
    if ((await getSessionOption(name, HOME_KIND_OPTION)) === "tasks") return name
    await runTmux(["kill-session", "-t", `=${name}`])
  }
  // Main "no task" welcome pane first, then split the Tasks rail in on its
  // LEFT (`-b`) at the same fixed cell width a real session uses.
  const r0 = await runTmuxCapturing([
    "new-session",
    "-d",
    "-s",
    name,
    "-c",
    SAFE_SPAWN_CWD,
    "-x",
    "220",
    "-y",
    "50",
    "-P",
    "-F",
    "#{pane_id}",
    homeWelcomeCommand(),
  ])
  const mainPane = r0.stdout.trim()
  if (mainPane) {
    // Match the user's global rail width so home looks like the tasks do.
    const tasksWidth = await globalTasksPaneWidth()
    const r1 = await runTmuxCapturing([
      "split-window",
      "-h",
      "-b",
      "-t",
      mainPane,
      "-l",
      `${tasksWidth}`,
      "-c",
      SAFE_SPAWN_CWD,
      "-P",
      "-F",
      "#{pane_id}",
      // Pin kobe's env (KOBE_HOME_DIR / KOBE_DAEMON_SOCKET_PATH / KOBE_TMUX_SOCKET)
      // onto the home rail's command, exactly like buildPanesAround / the heal
      // respawns do. Without it the home rail inherits whatever env the tmux
      // SERVER was born with — which goes stale when the server persists across
      // kobe relaunches (KOBE_* aren't in tmux's update-environment list), so a
      // non-default-home run that lands on home could read/mutate the PRODUCTION
      // tasks.json / a dead daemon — the stale-list desync class.
      keepAlive(inheritedEnvPrefix() + tasksPaneCommand(kobeCliInvocation())),
    ])
    const tasksPane = r1.stdout.trim()
    if (tasksPane) {
      await runTmuxSequence([
        ["set-option", "-p", "-t", tasksPane, PANE_ROLE_OPTION, "tasks"],
        ["select-pane", "-t", tasksPane],
      ])
    }
  }
  await setSessionOption(name, HOME_KIND_OPTION, "tasks")
  return name
}

/**
 * If the current tmux client is attached to `killedName`, switch it away
 * before the session is killed so the terminal doesn't go dark.
 *
 * Prefers `nextSessionName` when it exists; falls back to the kobe-home
 * placeholder session (created on demand). No-ops when the current session
 * is not `killedName` (e.g. called from the outer monitor).
 */
export async function switchClientBeforeKill(killedName: string, nextSessionName?: string): Promise<void> {
  const current = await currentSessionName()
  if (current !== killedName) return
  // Switch via enterWindow so the target is fit before the client lands on it —
  // deleting the active task must not drop the client onto a session sized to
  // whatever client last touched it (it would reflow on arrival). enterWindow is
  // the single fit+switch owner; dynamic import avoids a static cycle (panes/
  // terminal/tmux re-exports from this module).
  const { enterWindow } = await import("../tui/panes/terminal/tmux.ts")
  if (nextSessionName && nextSessionName !== killedName && (await sessionExists(nextSessionName))) {
    await enterWindow(nextSessionName)
    return
  }
  await enterWindow(await ensureFallbackSession())
}
