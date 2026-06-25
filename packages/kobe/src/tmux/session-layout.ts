/**
 * Pure command/layout builders for a task's tmux session.
 *
 * The session-build procedure (`tui/panes/terminal/tmux.ts`
 * `ensureSession`) is unavoidably imperative — it spawns `tmux
 * new-session` / `split-window` against a real server. But the
 * *policy* it encodes — pane sizes, which shell command each pane
 * runs, the keep-alive wrapper, the Ops-pane fallback — is pure data
 * + string building. Pulling it out here makes that policy unit
 * testable without a real tmux server, which is exactly the surface
 * that bit us in KOB-233 (quoting + targeting bugs that only showed
 * up at runtime).
 *
 * Everything in this file is pure: same inputs → same strings, no IO.
 */

import { quoteShellArg, quoteShellArgv } from "@/lib/shell-command"

/**
 * Far-left Tasks pane width in CELLS — FIXED, not a % of the window
 * (KOB-248). A %-split drifted: the pane's absolute width changed with the
 * terminal size, between chat-tab windows, and across engine (claude/codex)
 * rebuilds (tmux re-lays-out %-panes on those events). Direct-tmux mode
 * makes this pane the primary navigator, not a tiny preview rail, so 32 cells
 * is the convention width that fits Working/Archives, task titles, and the
 * shortcut legend without clipped text.
 */
export const TASKS_PANE_WIDTH = 32
export const TASKS_PANE_ROLE = "tasks"
export const ENGINE_PANE_ROLE = "claude"
export const OPS_PANE_ROLE = "ops"
export const SHELL_PANE_ROLE = "shell"
export const WORKSPACE_AUX_PANE_ROLE = "workspace_aux"
export const WORKSPACE_SPLIT_MAX_PANES = 4
export const HIDDEN_TERMINAL_PANE_OPTION = "@kobe_hidden_shell_pane"
export const HIDDEN_TASKS_PANE_OPTION = "@kobe_hidden_tasks_pane"
/**
 * While zen mode is active this window option holds the comma-joined list of
 * pane roles zen hid (`ops`, `terminal`, `tasks`), so leaving zen restores
 * exactly those panes and nothing the user had already collapsed themselves.
 */
export const ZEN_HIDDEN_PANES_OPTION = "@kobe_zen_panes"

/**
 * Session-scoped flag marking zen mode as ON for the WHOLE session (every
 * ChatTab), not just one window. When set, the zen toggle collapses/expands
 * all engine ChatTabs at once, and a freshly created ChatTab opens collapsed
 * too — so zen survives tab switches and new tabs. Per-window restore detail
 * still lives in {@link ZEN_HIDDEN_PANES_OPTION} on each window.
 */
export const ZEN_SESSION_OPTION = "@kobe_zen"

/** Hidden helper session that holds panes broken out of one task session. */
export function hiddenTerminalSessionName(session: string): string {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, "")
  return `kobe-hidden-${safe || "session"}`
}

/** Stable hidden-window slot for a ChatTab's active window id. */
export function hiddenTerminalWindowIndex(windowId: string): number {
  const n = Number.parseInt(windowId.replace(/^@/, ""), 10)
  return Number.isFinite(n) && n >= 0 ? 1000 + n : 1000
}

/**
 * Server-scoped tmux user option holding the user's GLOBAL Tasks-rail width in
 * cells. One value shared by every task session, so the rail stays the same
 * width across task switches: the user drags it once and it sticks everywhere
 * (captured on switch-away, applied on every session build/reuse). Unset → the
 * `TASKS_PANE_WIDTH` convention default.
 */
export const TASKS_WIDTH_OPTION = "@kobe_tasks_width"

/** Sane bounds for a user-chosen Tasks-rail width (cells). */
export const TASKS_PANE_WIDTH_MIN = 16
export const TASKS_PANE_WIDTH_MAX = 120

/** Clamp a candidate Tasks-rail width to the sane range; default on garbage. */
export function clampTasksPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return TASKS_PANE_WIDTH
  return Math.max(TASKS_PANE_WIDTH_MIN, Math.min(TASKS_PANE_WIDTH_MAX, Math.round(width)))
}

/** Left (claude) pane width as a % of the window. */
export const CLAUDE_PANE_PERCENT = 60

/** Upper-right (Ops) pane height as a % of the right column. */
export const OPS_PANE_PERCENT = 50

/**
 * Server-scoped tmux user options holding the user's GLOBAL right-column
 * geometry, each a percentage OF THE WINDOW (the unit `resize-pane -x/-y N%`
 * uses), shared by every task session so the right column looks the same in
 * every task. Unset → the default split the layout builds, so a user who never
 * dragged the right column keeps today's behaviour untouched.
 *
 * - {@link RIGHT_COLUMN_WIDTH_OPTION}: the right column (Ops file-tree + the
 *   terminal below it) width as a % of the window.
 * - {@link OPS_HEIGHT_OPTION}: the Ops (file-tree) pane height as a % of the
 *   window, i.e. where the file-tree / terminal split sits.
 */
export const RIGHT_COLUMN_WIDTH_OPTION = "@kobe_right_width_pct"
export const OPS_HEIGHT_OPTION = "@kobe_ops_height_pct"

/** Bounds for a pane split percentage — keeps neither side from collapsing. */
export const PANE_PERCENT_MIN = 10
export const PANE_PERCENT_MAX = 90

/** Clamp a split percentage to the sane range; `null` on garbage (skip it). */
export function clampPanePercent(percent: number): number | null {
  if (!Number.isFinite(percent)) return null
  return Math.max(PANE_PERCENT_MIN, Math.min(PANE_PERCENT_MAX, Math.round(percent)))
}

/**
 * Quote `s` for safe inclusion inside a single-line `sh -c` command.
 * tmux runs each pane command via `sh -c`, and we build that command
 * string ourselves, so any path with a space or quote needs POSIX
 * single-quote escaping (`'` → `'\''`).
 */
export function shellQuote(s: string): string {
  return quoteShellArg(s)
}

/** Shell-quote each argv element and join — a safe command line. */
export function shellQuoteArgv(argv: readonly string[]): string {
  return quoteShellArgv(argv)
}

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
 * Engines) and how to retry (`R` = relaunch). Exit 0 is unchanged: the
 * pane drops straight to the shell with no banner, as before. `__rc` is
 * captured immediately so the embedded command (which may contain any
 * characters — it's already composed/quoted by callers) can't perturb
 * it.
 */
export function keepAlive(cmd: string): string {
  // Literal UTF-8 glyphs (⚠ →), not `\uXXXX`: POSIX `printf` doesn't
  // interpret `\u`, and the wrapper shell may be plain `sh`. Only `\n`
  // (newline) and `%s` (the exit code) are printf-interpreted. No stray
  // `%` in the prose, so the format string is safe.
  const banner =
    "\\n  ⚠ Engine exited (code %s). Check Settings → Engines, fix the launch command, then press R to relaunch.\\n\\n"
  return `${cmd}; __rc=$?; [ "$__rc" -ne 0 ] && printf '${banner}' "$__rc"; exec "\${SHELL:-/bin/sh}"`
}

/** Single-quote a string for safe interpolation into a `sh -c` program. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

/**
 * The kobe-home "no task" main pane — the welcome area to the right of the
 * Tasks rail in the home layout. Purely informational: the Tasks rail owns
 * every key (n = new task, etc.), so this pane just explains what to do.
 * Ends in an `exec $SHELL` so the pane survives instead of collapsing the
 * window if its command ever returns. tmux runs it via its own `sh -c`.
 */
export function homeWelcomeCommand(): string {
  const msg = "\\n  No task selected\\n\\n  Press N to create a task, or pick one on the left.\\n\\n"
  return `clear; printf ${shQuote(msg)}; exec "\${SHELL:-/bin/sh}"`
}

export interface EngineInitLaunch {
  /**
   * Raw shell to run before the engine. Runs in the SAME shell that execs
   * the engine (a `{ …; }` group, NOT a `( … )` subshell) so any `export`
   * reaches the engine. Already a shell snippet (e.g. `sh .kobe/init.sh`
   * or a user override) — not shell-quoted.
   */
  readonly initScript?: string
  /**
   * When set, the init script runs only if this marker file is ABSENT,
   * then the marker is created on success — once-per-worktree semantics.
   * Omit to run the init script on every (re)launch.
   */
  readonly markerPath?: string
}

/**
 * Build the pane-0 launch line: optional init script, then the engine,
 * then a keep-alive shell. The whole thing is handed to tmux as a single
 * command string and run via its own `sh -c`.
 *
 * The init script runs in a brace group so its `export`s propagate to the
 * engine; `$?` after the group gates the marker touch so a failed init
 * (e.g. offline `pnpm install`) is retried next launch instead of being
 * marked done.
 */
export function engineLaunchLine(engineCmd: string, init?: EngineInitLaunch): string {
  const tail = keepAlive(engineCmd)
  const script = init?.initScript?.trim()
  if (!script) return tail
  const group = ["{", script, "}"].join("\n")
  if (init?.markerPath) {
    const marker = shQuote(init.markerPath)
    const markerDir = shQuote(markerDirOf(init.markerPath))
    return [
      `if [ ! -f ${marker} ]; then`,
      group,
      `if [ $? -eq 0 ]; then mkdir -p ${markerDir} && : > ${marker}; fi`,
      "fi",
      tail,
    ].join("\n")
  }
  return [group, tail].join("\n")
}

/** Parent dir of a marker path, without importing node:path into this pure module's hot path. */
function markerDirOf(p: string): string {
  const i = p.lastIndexOf("/")
  return i <= 0 ? "." : p.slice(0, i)
}

/**
 * Inline shell loop that prints `git status` + a worktree tree once a
 * second. Used as the Ops pane's `|| fallback` when `kobe ops` can't
 * launch, or directly when there's no task id to wire `kobe ops` to.
 */
export function fallbackOpsScript(cwd: string): string {
  return `\
cd ${shellQuote(cwd)} && \
while :; do \
  clear; \
  printf "\\033[1m# %s\\033[0m\\n\\n" ${shellQuote(cwd)}; \
  git status --short --branch 2>/dev/null | sed 's/^/  /' || true; \
  printf "\\n"; \
  if command -v lsd >/dev/null 2>&1; then \
    lsd --tree --git -I node_modules -I .git --depth 2 .; \
  elif command -v eza >/dev/null 2>&1; then \
    eza --tree --git -L 2 -I 'node_modules|.git' .; \
  elif command -v tree >/dev/null 2>&1; then \
    tree -L 2 -I 'node_modules|.git'; \
  else \
    ls -la; \
  fi; \
  sleep 2; \
done`
}

/**
 * Shell command for the full-width preview window opened when the user
 * activates a file in the Ops pane (KOB-233). Runs in a fresh tmux
 * window so review gets the whole terminal width.
 *
 * Primary path: `kobe ops --preview <rel>` — opentui's `<diff>` /
 * `<code>` renderables give tree-sitter syntax highlighting + line
 * numbers with zero external dependencies (the raw-`git diff | less`
 * approach had no highlighting unless the user had `delta` installed).
 * `q` in that view exits the process → tmux closes the window → back
 * to the three-pane main window.
 *
 * `|| fallback`: if `kobe ops --preview` can't launch, drop to the
 * user's own pager (`delta`/`less` for a diff, `bat`/`less` for
 * content) so the window is never blank.
 */
export function previewWindowCommand(args: {
  worktree: string
  relPath: string
  cliInvocation: readonly string[]
}): string {
  const wt = shellQuote(args.worktree)
  const file = shellQuote(args.relPath)
  const inv = args.cliInvocation.map(shellQuote).join(" ")
  const fallback =
    `cd ${wt} && if ! git diff --quiet HEAD -- ${file} 2>/dev/null; then ` +
    `git diff HEAD -- ${file} | { delta --paging=always 2>/dev/null || less -R; }; ` +
    `else bat --style=plain --paging=always ${file} 2>/dev/null || \${PAGER:-less} ${file} 2>/dev/null || cat ${file}; fi`
  return `${inv} ops --worktree ${wt} --preview ${file} || { ${fallback}; }`
}

/**
 * Shell command for the full-window update page opened from the tmux
 * Tasks pane. This mirrors the Settings/New Task full-page surfaces:
 * a dedicated window owns update copy, release notes, and the updater
 * handoff instead of squeezing that state into the Tasks footer.
 */
export function updatePageCommand(args: { cliInvocation: readonly string[] }): string {
  return `${shellQuoteArgv([...args.cliInvocation, "update-page"])}`
}

/**
 * Shell command for the prefix-scoped URL opener. It captures the focused pane
 * as logical lines (`-J`, so wrapped URLs rejoin), lets the user pick with fzf
 * when available, and opens the most recent URL otherwise.
 */
export function openUrlCommand(args: { readonly tmuxSocket: string; readonly opener?: string }): string {
  const opener = args.opener ?? "open"
  return [
    `tmux -L ${shellQuote(args.tmuxSocket)} capture-pane -Jp -t '#{pane_id}' -S -500`,
    `grep -oiE 'https?://[^ "'\\''()<>]+'`,
    "awk '!seen[$0]++'",
    "{ command -v fzf >/dev/null && fzf --reverse || tail -1; }",
    `xargs -I{} ${opener} {}`,
  ].join(" | ")
}

/**
 * The far-left Tasks pane command — `kobe tasks` (a read-only task
 * list that `switch-client`s between sessions). `cliInvocation` is the
 * argv prefix that runs the kobe CLI (injected for purity/testability).
 */
export function tasksPaneCommand(
  cliInvocation: readonly string[],
  opts: { readonly initialTaskId?: string } = {},
): string {
  const argv = [...cliInvocation, "tasks"]
  if (opts.initialTaskId) argv.push("--initial-task-id", opts.initialTaskId)
  return shellQuoteArgv(argv)
}

/**
 * The Ops pane's shell command. Prefers `kobe ops` (the FileTree pane);
 * `|| fallback` keeps a useful git-status + tree watcher if that launch
 * fails. Returns a single `sh -c`-ready string.
 *
 * `cliInvocation` is the argv prefix that runs the kobe CLI (from
 * `cli/invocation.ts`) — injected rather than imported so this stays
 * pure + testable. `claudePaneId` is the tmux pane id (`%N`) of the
 * claude pane; `kobe ops` uses it as the `--target-pane` for `@file`
 * mention injection back into claude.
 */
export function opsPaneCommand(args: {
  cwd: string
  taskId: string | undefined
  claudePaneId: string | null
  cliInvocation: readonly string[]
  /** Task engine vendor — `kobe ops` polls this engine's transcript for the activity badge. */
  vendor?: string
}): string {
  if (args.taskId && args.claudePaneId) {
    const inv = args.cliInvocation.map(shellQuote).join(" ")
    const vendorFlag = args.vendor ? ` --vendor ${shellQuote(args.vendor)}` : ""
    return (
      `KOBE_FILETREE_WATCH=1 ${inv} ops --task-id ${shellQuote(args.taskId)} --worktree ${shellQuote(args.cwd)} ` +
      `--target-pane ${shellQuote(args.claudePaneId)}${vendorFlag} || { ${fallbackOpsScript(args.cwd)}; }`
    )
  }
  return fallbackOpsScript(args.cwd)
}
