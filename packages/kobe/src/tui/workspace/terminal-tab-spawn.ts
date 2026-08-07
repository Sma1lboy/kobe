/**
 * Shell-wrapping helpers for a terminal tab's PTY spawn — the argv → typed
 * shell command line translation, split out of `terminal-tabs-core.ts` (the
 * tab-list transitions) purely for the 500-line file-size cap. Self-contained:
 * no tab-shape imports, just string → `TabSpawn`. Kept as its own module so
 * both the core transitions and the component read one source for the
 * shell-quoting rule.
 */

/** What a tab's PTY should spawn: an argv, plus optional bytes typed into
 *  it right after spawn (`TaskPtyOpts.initialInput`). */
export interface TabSpawn {
  readonly command: readonly string[]
  readonly initialInput?: string
}

/** Args that survive an interactive prompt unquoted; anything else gets
 *  single-quoted (`'\''` escape) — POSIX shells and fish both accept it. */
const SHELL_SAFE_ARG = /^[A-Za-z0-9@%+=:,./_-]+$/

/** Render an argv as one shell-ready command line. */
export function shellCommandLine(argv: readonly string[]): string {
  return argv.map((a) => (SHELL_SAFE_ARG.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(" ")
}

/**
 * Wrap an engine argv in the user's interactive shell: the PTY spawns
 * `shell` and the engine command line is TYPED into it (kernel tty input
 * buffering holds it until the shell is ready). This keeps the user's
 * full shell context — rc files, aliases, PATH — and exiting the engine
 * lands on the shell prompt instead of killing the tab.
 *
 * `env` rides the typed line as an `env K=V …` prefix (not the PTY's own
 * environment): it reaches fresh spawns AND adopted warm shells through the
 * same path, works in fish (which rejects the bare `K=V cmd` prefix), and
 * needs no per-backend plumbing. The engine's hook subprocesses inherit it —
 * how `kobe hook` learns which TAB an activity event came from.
 */
export function shellSpawn(argv: readonly string[], shell: string, env?: Readonly<Record<string, string>>): TabSpawn {
  const pairs = Object.entries(env ?? {})
  const full = pairs.length > 0 ? ["env", ...pairs.map(([k, v]) => `${k}=${v}`), ...argv] : argv
  return { command: [shell], initialInput: `${shellCommandLine(full)}\r` }
}

/**
 * Identity export line for a BARE shell tab (the ctrl+e "shell" pick) — the
 * plain-shell sibling of {@link shellSpawn}'s `env` prefix. A user typing an
 * engine (`claude`) into this shell makes its hook subprocesses inherit
 * `KOBE_TASK_ID`/`KOBE_TAB_ID`, so the daemon gets tab-precise events + the
 * session id for a session kobe never spawned. Typed via `initialInput`
 * (same mechanism engine launch lines use): reaches fresh spawns AND
 * adopted warm spares, zero pty protocol change. Leading space keeps it out
 * of HIST_IGNORE_SPACE shells' history; `clear` hides it from scrollback.
 * ponytail: one visible line flashes before the clear; upgrade path = an
 * `env` field on PtySpawnSpec with a skip-spare rule if cosmetics matter.
 */
export function shellIdentityInput(taskId: string, tabId: string): string {
  return ` export KOBE_TASK_ID=${shellCommandLine([taskId])} KOBE_TAB_ID=${shellCommandLine([tabId])} && clear\r`
}
