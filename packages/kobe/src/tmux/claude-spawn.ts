/**
 * Pure helpers for spawning `claude` inside a tmux pane and recovering
 * the session-id it allocates on disk.
 *
 * Why "pure": this module never spawns a subprocess and never talks to
 * tmux. It only builds shell-command strings (which the caller hands to
 * `tmux split-window -d <command>` etc.) and runs the *listing* side of
 * the session-id sniff. Real fs IO is injected through {@link SnifferDeps}
 * so tests can drive every path without touching `~/.claude/`.
 *
 * How Claude Code allocates a session id (see refs/opcode): the first
 * time you exec `claude` in a given cwd, it creates a fresh JSONL at
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`. Resuming an
 * existing session reuses the same file. We diff the directory listing
 * before vs after spawn to recover the newly-created session id without
 * having to read claude's stdout (which we don't have — the pane owns
 * it).
 */

/**
 * Build the shell command string a tmux pane should exec to run claude
 * in the given mode.
 *
 * Output shape: `cd '<cwd>' && exec '<bin>' [--resume '<sid>']`. We
 * single-quote-escape every interpolated value with the canonical
 * `'\''` trick so paths/sessions containing spaces, ampersands, or
 * single quotes survive intact. `exec` drops the wrapping shell so
 * tmux sees one process per pane (mirrors `layout.ts:placeholderShellCommand`).
 */
export interface BuildClaudeShellCommandOptions {
  readonly binaryPath: string
  /**
   * Absolute path to the worktree directory the pane should cd into
   * before exec. The pane's cwd at the tmux level is unrelated; we
   * always cd explicitly so the session is rooted at the worktree.
   */
  readonly cwd: string
  /** Optional `--resume <sessionId>`. Set when (taskId, tabId) already has a session. */
  readonly resumeSessionId?: string
}

export function buildClaudeShellCommand(opts: BuildClaudeShellCommandOptions): string {
  const cwd = singleQuote(opts.cwd)
  const bin = singleQuote(opts.binaryPath)
  const resume = opts.resumeSessionId ? ` --resume ${singleQuote(opts.resumeSessionId)}` : ""
  return `cd ${cwd} && exec ${bin}${resume}`
}

/**
 * Injection seam for {@link sniffNewSessionId}. The real implementation
 * encodes the cwd into Claude Code's project-dir name (`/` and `.`
 * replaced with `-` — see `engine/claude-code-local/history.ts:encodeCwd`)
 * and lists `~/.claude/projects/<encoded-cwd>/`.
 */
export interface SnifferDeps {
  encodeCwd(cwd: string): string
  /** List filenames immediately under the given absolute directory. Empty array if the dir doesn't exist yet. */
  list(projectDir: string): Promise<string[]>
  homedir(): string
}

/**
 * Diff a project directory's listing against a pre-spawn snapshot and
 * return the first `*.jsonl` filename (sans extension) that wasn't
 * there before. The session id is exactly the bare filename — Claude
 * Code writes `<sessionId>.jsonl` and nothing else there.
 *
 * Returns `null` when nothing new appeared. Callers may retry / give
 * up; we don't poll internally on purpose so the decision (and the
 * delay between attempts) stays at the call site.
 */
export async function sniffNewSessionId(
  cwd: string,
  before: ReadonlySet<string>,
  deps: SnifferDeps,
): Promise<string | null> {
  const projectDir = `${deps.homedir()}/.claude/projects/${deps.encodeCwd(cwd)}`
  const after = await deps.list(projectDir)
  for (const name of after) {
    if (!name.endsWith(".jsonl")) continue
    const sessionId = name.slice(0, -".jsonl".length)
    if (sessionId.length === 0) continue
    if (before.has(name)) continue
    return sessionId
  }
  return null
}

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
