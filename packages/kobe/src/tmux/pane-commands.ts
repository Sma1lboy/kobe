/**
 * Pure shell-command builders for the non-engine panes/windows of a task
 * session — Tasks rail, Ops pane (+ its git-status fallback), the home
 * welcome pane, the preview/update windows, and the URL opener. Internal to
 * `src/tmux/`: import via `./session-layout.ts` (the public entry for every
 * pure tmux-layout builder) from outside this directory. Everything here is
 * pure: same inputs → same strings, no IO.
 */

import { quoteShellArg, quoteShellArgv } from "@/lib/shell-command"

/**
 * The kobe-home "no task" main pane — the welcome area to the right of the
 * Tasks rail in the home layout. Purely informational: the Tasks rail owns
 * every key (n = new task, etc.), so this pane just explains what to do.
 * Ends in an `exec $SHELL` so the pane survives instead of collapsing the
 * window if its command ever returns. tmux runs it via its own `sh -c`.
 */
export function homeWelcomeCommand(): string {
  const msg = "\\n  No task selected\\n\\n  Press N to create a task, or pick one on the left.\\n\\n"
  return `clear; printf ${quoteShellArg(msg)}; exec "\${SHELL:-/bin/sh}"`
}

/**
 * Inline shell loop that prints `git status` + a worktree tree once a
 * second. Used as the Ops pane's `|| fallback` when `kobe ops` can't
 * launch, or directly when there's no task id to wire `kobe ops` to.
 */
export function fallbackOpsScript(cwd: string): string {
  return `\
cd ${quoteShellArg(cwd)} && \
while :; do \
  clear; \
  printf "\\033[1m# %s\\033[0m\\n\\n" ${quoteShellArg(cwd)}; \
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
 * activates a file in the Ops pane. Runs in a fresh tmux
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
  const wt = quoteShellArg(args.worktree)
  const file = quoteShellArg(args.relPath)
  const inv = args.cliInvocation.map((a) => quoteShellArg(a)).join(" ")
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
  return `${quoteShellArgv([...args.cliInvocation, "update-page"])}`
}

/**
 * Shell command for the prefix-scoped URL opener. It captures the focused pane
 * as logical lines (`-J`, so wrapped URLs rejoin), lets the user pick with fzf
 * when available, and opens the most recent URL otherwise.
 */
export function openUrlCommand(args: { readonly tmuxSocket: string; readonly opener?: string }): string {
  const opener = args.opener ?? "open"
  return [
    `tmux -L ${quoteShellArg(args.tmuxSocket)} capture-pane -Jp -t '#{pane_id}' -S -500`,
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
  return quoteShellArgv(argv)
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
    const inv = args.cliInvocation.map((a) => quoteShellArg(a)).join(" ")
    const vendorFlag = args.vendor ? ` --vendor ${quoteShellArg(args.vendor)}` : ""
    return (
      `KOBE_FILETREE_WATCH=1 ${inv} ops --task-id ${quoteShellArg(args.taskId)} --worktree ${quoteShellArg(args.cwd)} ` +
      `--target-pane ${quoteShellArg(args.claudePaneId)}${vendorFlag} || { ${fallbackOpsScript(args.cwd)}; }`
    )
  }
  return fallbackOpsScript(args.cwd)
}
