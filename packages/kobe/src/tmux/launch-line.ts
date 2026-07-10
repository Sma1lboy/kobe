/**
 * Pure builders for the engine pane's launch line — the keep-alive wrapper,
 * the repo-init watchdog, and the tab-exit cleanup hook. Internal to
 * `src/tmux/`: import via `./session-layout.ts` (the public entry for every
 * pure tmux-layout builder) from outside this directory. Everything here is
 * pure: same inputs → same strings, no IO.
 */

import { quoteShellArg } from "@/lib/shell-command"

/**
 * Engine panes get this guard: a fast Ctrl+C while the engine is still
 * starting (or while the per-repo init script runs) would otherwise SIGINT
 * the whole `sh -c` process group and kill the wrapper BEFORE it reaches the
 * fallback shell — closing the pane mid-init. The guard makes the wrapper
 * ignore SIGINT (the engine child resets to the default, so Ctrl+C still
 * interrupts it).
 */
export const SIGINT_GUARD = "trap ':' INT; "

/**
 * Wrap a pane command so the pane survives the command exiting: drop
 * to an interactive shell instead of letting tmux close the pane (which
 * would collapse the layout). claude exiting → shell; `kobe ops`
 * exiting → shell; the Ops fallback loops forever so it never reaches
 * the exec.
 *
 * If the wrapped command exits NON-ZERO, print a legible banner before
 * dropping to the shell. Without it a typo'd launch command (e.g. a
 * custom engine registered as `claue`) prints `sh: claue: not found`
 * for a frame and then lands on a bare prompt — indistinguishable from
 * a healthy idle shell, so the user assumes kobe is broken. The banner
 * names the failing exit code and points at where to fix it (Settings →
 * Engines). Exit 0 is unchanged: the pane drops straight to the shell with
 * no banner, as before. `__rc` is captured immediately so the embedded
 * command (which may contain any characters — it's already composed/quoted
 * by callers) can't perturb it.
 *
 * `onExit` (engine panes only): a command to run AFTER the fallback shell
 * itself exits — i.e. the user typed `exit` in the post-engine shell, fully
 * tearing this tab's engine down. We replace the terminal `exec "$SHELL"`
 * with `"$SHELL"; <onExit>` so the wrapper survives the shell and can act on
 * its exit (e.g. close/replace this chat tab). Without `onExit` the behavior
 * is identical to before (`exec`), so Ops/Tasks/home panes are unaffected.
 * Engine panes also get {@link SIGINT_GUARD}.
 */
export function keepAlive(cmd: string, onExit?: string): string {
  // Literal UTF-8 glyphs (⚠ →), not `\uXXXX`: POSIX `printf` doesn't
  // interpret `\u`, and the wrapper shell may be plain `sh`. Only `\n`
  // (newline) and `%s` (the exit code) are printf-interpreted. No stray
  // `%` in the prose, so the format string is safe.
  const banner = "\\n  ⚠ Engine exited (code %s). Check Settings → Engines and fix the launch command.\\n\\n"
  // Engine panes (onExit set) guard the wrapper against a startup Ctrl+C.
  const guard = onExit ? SIGINT_GUARD : ""
  const head = `${guard}${cmd}; __rc=$?; [ "$__rc" -ne 0 ] && printf '${banner}' "$__rc"; `
  // No `onExit`: exec the shell so it BECOMES the pane (original behavior).
  // With `onExit`: run the shell as a child, then run the cleanup when it exits.
  return onExit ? `${head}"\${SHELL:-/bin/sh}"; ${onExit}` : `${head}exec "\${SHELL:-/bin/sh}"`
}

/**
 * Keep-alive wrapper for the read-only archived-history preview pane (`kobe
 * history`, shown in the engine pane slot when an archived task is opened with
 * `experimental.archivedHistoryPreview` on).
 *
 * This pane must NEVER follow the engine pane's {@link keepAlive} `onExit` path:
 * that drops to a fallback shell and then runs `kobe engine-tab-exit`, which on
 * a task's ONLY tab opens a fresh chat tab via `newChatTab` — spawning a LIVE
 * ENGINE. Relaunching a real engine on an ARCHIVED task is precisely what the
 * preview exists to avoid (no engine spawn, no worktree re-materialize). So the
 * preview is a PERSISTENT pane like the Ops fallback: SIGINT is ignored and
 * `kobe history` is re-launched in a guarded loop, so closing/quitting the
 * preview can never collapse the pane into a shell or an engine. The user leaves
 * the preview the same way they leave any pane — the Tasks rail or Ctrl+Q — not
 * by exiting this pane. The `sleep 1` bounds a re-launch spin if the history
 * host can't boot.
 */
export function historyPaneKeepAlive(cmd: string): string {
  return `trap '' INT; while :; do ${cmd}; sleep 1; done`
}

/**
 * Build the engine pane's {@link keepAlive} `onExit` cleanup command: after the
 * user exits the post-engine fallback shell (fully tearing this tab's engine
 * down), run `kobe engine-tab-exit --session <name>`, which closes this chat
 * tab — or, when it is the task's only tab, replaces it with a fresh engine tab
 * so the task session never goes empty. `envPrefix` carries the inherited
 * KOBE_* env (same reason the pane commands do); `inv` is the resolved kobe CLI
 * argv. The session name is baked in (quoted) since it is known at build time.
 */
export function engineTabExitCleanup(envPrefix: string, inv: readonly string[], session: string): string {
  return `${envPrefix}${inv.map((a) => quoteShellArg(a)).join(" ")} engine-tab-exit --session ${quoteShellArg(session)}`
}

export interface EngineInitLaunch {
  /**
   * Raw shell to run before the engine. Already a shell snippet (e.g.
   * `sh .kobe/init.sh` or a user override) — not shell-quoted. It is run
   * under a watchdog (see {@link engineLaunchLine}) so a hang can't wedge
   * task entry, yet any `export` it makes still reaches the engine.
   */
  readonly initScript?: string
  /**
   * When set, the init script runs only if this marker file is ABSENT,
   * then the marker is created on success — once-per-worktree semantics.
   * Omit to run the init script on every (re)launch.
   */
  readonly markerPath?: string
  /**
   * Watchdog budget for the init script in SECONDS. On expiry the init
   * subtree is killed and the launch continues to the engine. Omit for
   * {@link REPO_INIT_TIMEOUT_SECONDS}.
   */
  readonly timeoutSeconds?: number
}

/**
 * Default watchdog budget (seconds) for a repo's `.kobe/init.sh`.
 *
 * Sized for a real cold-cache install/build (the common heavy init: `npm
 * ci`, `pnpm install`, `cargo build`) to finish, while still bounding an
 * outright hang — an infinite loop, a network stall, or an interactive
 * `read`/password prompt that would otherwise block `tmux new-session`
 * forever and leave the task permanently unenterable. 120s is the ceiling,
 * not a target: a healthy init returns in well under it.
 */
export const REPO_INIT_TIMEOUT_SECONDS = 120

/** Sane bounds for an init-watchdog budget (seconds). */
export const REPO_INIT_TIMEOUT_MIN_SECONDS = 5
export const REPO_INIT_TIMEOUT_MAX_SECONDS = 3600

/**
 * Resolve the init-watchdog budget from a raw override (env/string),
 * clamped to the sane range. Garbage / unset → the default. Kept pure so
 * the env escape hatch (`KOBE_REPO_INIT_TIMEOUT_SECONDS`) is unit-testable
 * without spawning a shell.
 */
export function resolveRepoInitTimeoutSeconds(raw?: string | number | null): number {
  const n = typeof raw === "number" ? raw : raw == null ? Number.NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return REPO_INIT_TIMEOUT_SECONDS
  return Math.max(REPO_INIT_TIMEOUT_MIN_SECONDS, Math.min(REPO_INIT_TIMEOUT_MAX_SECONDS, Math.round(n)))
}

/**
 * Bound the init snippet with a POSIX-portable watchdog so a hang can't
 * wedge task entry. macOS ships no GNU `timeout(1)` and the snippet runs
 * inside a plain `sh -c` under tmux, so we hand-roll it: run the init in a
 * backgrounded subshell with stdin from `/dev/null` (an interactive
 * `read`/password prompt gets EOF instead of blocking forever), arm a
 * `sleep N && kill` watchdog (TERM, then KILL after a 2s grace), and
 * `wait`. On a clean finish the watchdog is cancelled.
 *
 * The "SAME shell so `export`s reach the engine" contract is preserved
 * across the subshell boundary: on success the subshell dumps its exported
 * environment (`export -p`) to a temp file that the OUTER shell sources, so
 * the engine — `exec`'d later in that same outer shell — still sees the
 * init's exports. On timeout or non-zero exit nothing is sourced, a legible
 * banner is printed, and `__kobe_init_rc` is left non-zero so the caller's
 * marker touch is skipped (init retried next launch).
 */
function boundedInitGroup(script: string, timeoutSeconds: number): string {
  const n = String(timeoutSeconds)
  // Literal UTF-8 ⚠ glyph; only `\n` and `%s` are printf-interpreted, no
  // stray `%` in the prose, so the format strings are safe under plain sh.
  const timeoutBanner =
    "\\n  ⚠ Repo init (.kobe/init.sh) timed out after %ss and was killed; continuing to the engine.\\n\\n"
  const failBanner = "\\n  ⚠ Repo init (.kobe/init.sh) failed (code %s); continuing to the engine.\\n\\n"
  return [
    `__kobe_init_env="\${TMPDIR:-/tmp}/kobe-init-env.$$"`,
    `__kobe_init_to="\${TMPDIR:-/tmp}/kobe-init-timeout.$$"`,
    `rm -f "$__kobe_init_env" "$__kobe_init_to" 2>/dev/null`,
    "(",
    script,
    "__kobe_init_ec=$?",
    `export -p > "$__kobe_init_env" 2>/dev/null`,
    "exit $__kobe_init_ec",
    ") </dev/null &",
    "__kobe_init_pid=$!",
    `( sleep ${n}; : > "$__kobe_init_to"; kill -TERM "$__kobe_init_pid" 2>/dev/null; sleep 2; kill -KILL "$__kobe_init_pid" 2>/dev/null ) &`,
    "__kobe_init_wd=$!",
    `wait "$__kobe_init_pid" 2>/dev/null; __kobe_init_rc=$?`,
    // Cancel + reap the watchdog. The `wait` reaps it synchronously so a
    // shell with job control (bash as /bin/sh on macOS) doesn't print an
    // async "Terminated" notice into the pane.
    `kill "$__kobe_init_wd" 2>/dev/null; wait "$__kobe_init_wd" 2>/dev/null`,
    `if [ -f "$__kobe_init_to" ]; then __kobe_init_rc=124; printf '${timeoutBanner}' '${n}';`,
    `elif [ "$__kobe_init_rc" -eq 0 ]; then [ -f "$__kobe_init_env" ] && . "$__kobe_init_env" 2>/dev/null;`,
    `else printf '${failBanner}' "$__kobe_init_rc"; fi`,
    `rm -f "$__kobe_init_env" "$__kobe_init_to" 2>/dev/null`,
  ].join("\n")
}

/**
 * Build the pane-0 launch line: optional init script (watchdog-bounded),
 * then the engine, then a keep-alive shell. The whole thing is handed to
 * tmux as a single command string and run via its own `sh -c`.
 *
 * The init script is bounded by {@link boundedInitGroup} so a hang can't
 * wedge task entry; `$__kobe_init_rc` after it gates the marker touch so a
 * failed/timed-out init (e.g. offline `pnpm install`) is retried next
 * launch instead of being marked done. A failed/timed-out init never blocks
 * the engine — the task always becomes enterable.
 */
export function engineLaunchLine(engineCmd: string, init?: EngineInitLaunch, onExit?: string): string {
  const tail = keepAlive(engineCmd, onExit)
  const script = init?.initScript?.trim()
  if (!script) return tail
  const timeoutSeconds = resolveRepoInitTimeoutSeconds(init?.timeoutSeconds)
  const group = boundedInitGroup(script, timeoutSeconds)
  // SIGINT_GUARD up front so a Ctrl+C DURING the init script can't kill the
  // wrapper before it reaches the engine + fallback shell (keepAlive's own guard
  // only covers from the engine command onward). Redundant with the tail's guard
  // for the no-init path — harmless, `trap` is idempotent.
  if (init?.markerPath) {
    const marker = quoteShellArg(init.markerPath)
    const markerDir = quoteShellArg(markerDirOf(init.markerPath))
    return (
      SIGINT_GUARD +
      [
        `if [ ! -f ${marker} ]; then`,
        group,
        `if [ "$__kobe_init_rc" -eq 0 ]; then mkdir -p ${markerDir} && : > ${marker}; fi`,
        "fi",
        tail,
      ].join("\n")
    )
  }
  return SIGINT_GUARD + [group, tail].join("\n")
}

/** Parent dir of a marker path, without importing node:path into this pure module's hot path. */
function markerDirOf(p: string): string {
  const i = p.lastIndexOf("/")
  return i <= 0 ? "." : p.slice(0, i)
}
