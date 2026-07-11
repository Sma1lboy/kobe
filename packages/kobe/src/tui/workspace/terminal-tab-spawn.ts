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
 */
export function shellSpawn(argv: readonly string[], shell: string): TabSpawn {
  return { command: [shell], initialInput: `${shellCommandLine(argv)}\r` }
}
