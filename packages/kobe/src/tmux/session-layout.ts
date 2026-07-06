import { quoteShellArg, quoteShellArgv } from "@/lib/shell-command"

export const TASKS_PANE_WIDTH = 32
export const TASKS_PANE_ROLE = "tasks"
export const ENGINE_PANE_ROLE = "claude"
export const OPS_PANE_ROLE = "ops"
export const SHELL_PANE_ROLE = "shell"
export const WORKSPACE_AUX_PANE_ROLE = "workspace_aux"
export const WORKSPACE_SPLIT_MAX_PANES = 4
export const HIDDEN_TERMINAL_PANE_OPTION = "@kobe_hidden_shell_pane"
export const HIDDEN_TASKS_PANE_OPTION = "@kobe_hidden_tasks_pane"
export const ZEN_HIDDEN_PANES_OPTION = "@kobe_zen_panes"

export const ZEN_SESSION_OPTION = "@kobe_zen"

export function hiddenTerminalSessionName(session: string): string {
  const safe = session.replace(/[^A-Za-z0-9_-]/g, "")
  return `kobe-hidden-${safe || "session"}`
}

export function hiddenTerminalWindowIndex(windowId: string): number {
  const n = Number.parseInt(windowId.replace(/^@/, ""), 10)
  return Number.isFinite(n) && n >= 0 ? 1000 + n : 1000
}

export const TASKS_WIDTH_OPTION = "@kobe_tasks_width"

export const TASKS_PANE_WIDTH_MIN = 16
export const TASKS_PANE_WIDTH_MAX = 120

export function clampTasksPaneWidth(width: number): number {
  if (!Number.isFinite(width)) return TASKS_PANE_WIDTH
  return Math.max(TASKS_PANE_WIDTH_MIN, Math.min(TASKS_PANE_WIDTH_MAX, Math.round(width)))
}

export const CLAUDE_PANE_PERCENT = 60

export const OPS_PANE_PERCENT = 50

export const RIGHT_COLUMN_WIDTH_OPTION = "@kobe_right_width_pct"
export const OPS_HEIGHT_OPTION = "@kobe_ops_height_pct"

export const PANE_PERCENT_MIN = 10
export const PANE_PERCENT_MAX = 90

export function clampPanePercent(percent: number): number | null {
  if (!Number.isFinite(percent)) return null
  return Math.max(PANE_PERCENT_MIN, Math.min(PANE_PERCENT_MAX, Math.round(percent)))
}

export interface LayoutGeometry {
  readonly tasksWidth: number
  readonly rightColumnWidthPct: number
  readonly opsHeightPct: number
  readonly rightColumnResizeArgs: readonly string[]
}

export const LAYOUT_GEOMETRY_OPTIONS = [TASKS_WIDTH_OPTION, RIGHT_COLUMN_WIDTH_OPTION, OPS_HEIGHT_OPTION] as const

export function resolveLayoutGeometry(opts: Record<string, string | undefined>): LayoutGeometry {
  const rawWidth = Number.parseInt(opts[TASKS_WIDTH_OPTION] ?? "", 10)
  const tasksWidth = Number.isFinite(rawWidth) && rawWidth > 0 ? clampTasksPaneWidth(rawWidth) : TASKS_PANE_WIDTH
  const widthPct = clampPanePercent(Number.parseInt(opts[RIGHT_COLUMN_WIDTH_OPTION] ?? "", 10))
  const heightPct = clampPanePercent(Number.parseInt(opts[OPS_HEIGHT_OPTION] ?? "", 10))
  const rightColumnResizeArgs: string[] = []
  if (widthPct !== null) rightColumnResizeArgs.push("-x", `${widthPct}%`)
  if (heightPct !== null) rightColumnResizeArgs.push("-y", `${heightPct}%`)
  return {
    tasksWidth,
    rightColumnWidthPct: widthPct ?? 100 - CLAUDE_PANE_PERCENT,
    opsHeightPct: heightPct ?? OPS_PANE_PERCENT,
    rightColumnResizeArgs,
  }
}

export function shellQuote(s: string): string {
  return quoteShellArg(s)
}

export function shellQuoteArgv(argv: readonly string[]): string {
  return quoteShellArgv(argv)
}

export const SIGINT_GUARD = "trap ':' INT; "

export function keepAlive(cmd: string, onExit?: string): string {
  const banner = "\\n  ⚠ Engine exited (code %s). Check Settings → Engines and fix the launch command.\\n\\n"
  const guard = onExit ? SIGINT_GUARD : ""
  const head = `${guard}${cmd}; __rc=$?; [ "$__rc" -ne 0 ] && printf '${banner}' "$__rc"; `
  return onExit ? `${head}"\${SHELL:-/bin/sh}"; ${onExit}` : `${head}exec "\${SHELL:-/bin/sh}"`
}

export function historyPaneKeepAlive(cmd: string): string {
  return `trap '' INT; while :; do ${cmd}; sleep 1; done`
}

export function engineTabExitCleanup(envPrefix: string, inv: readonly string[], session: string): string {
  return `${envPrefix}${inv.map(shellQuote).join(" ")} engine-tab-exit --session ${shellQuote(session)}`
}

export function homeWelcomeCommand(): string {
  const msg = "\\n  No task selected\\n\\n  Press N to create a task, or pick one on the left.\\n\\n"
  return `clear; printf ${shellQuote(msg)}; exec "\${SHELL:-/bin/sh}"`
}

export interface EngineInitLaunch {
  readonly initScript?: string
  readonly markerPath?: string
  readonly timeoutSeconds?: number
}

export const REPO_INIT_TIMEOUT_SECONDS = 120

export const REPO_INIT_TIMEOUT_MIN_SECONDS = 5
export const REPO_INIT_TIMEOUT_MAX_SECONDS = 3600

export function resolveRepoInitTimeoutSeconds(raw?: string | number | null): number {
  const n = typeof raw === "number" ? raw : raw == null ? Number.NaN : Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return REPO_INIT_TIMEOUT_SECONDS
  return Math.max(REPO_INIT_TIMEOUT_MIN_SECONDS, Math.min(REPO_INIT_TIMEOUT_MAX_SECONDS, Math.round(n)))
}

function boundedInitGroup(script: string, timeoutSeconds: number): string {
  const n = String(timeoutSeconds)
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
    `kill "$__kobe_init_wd" 2>/dev/null; wait "$__kobe_init_wd" 2>/dev/null`,
    `if [ -f "$__kobe_init_to" ]; then __kobe_init_rc=124; printf '${timeoutBanner}' '${n}';`,
    `elif [ "$__kobe_init_rc" -eq 0 ]; then [ -f "$__kobe_init_env" ] && . "$__kobe_init_env" 2>/dev/null;`,
    `else printf '${failBanner}' "$__kobe_init_rc"; fi`,
    `rm -f "$__kobe_init_env" "$__kobe_init_to" 2>/dev/null`,
  ].join("\n")
}

export function engineLaunchLine(engineCmd: string, init?: EngineInitLaunch, onExit?: string): string {
  const tail = keepAlive(engineCmd, onExit)
  const script = init?.initScript?.trim()
  if (!script) return tail
  const timeoutSeconds = resolveRepoInitTimeoutSeconds(init?.timeoutSeconds)
  const group = boundedInitGroup(script, timeoutSeconds)
  if (init?.markerPath) {
    const marker = shellQuote(init.markerPath)
    const markerDir = shellQuote(markerDirOf(init.markerPath))
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

function markerDirOf(p: string): string {
  const i = p.lastIndexOf("/")
  return i <= 0 ? "." : p.slice(0, i)
}

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

export function updatePageCommand(args: { cliInvocation: readonly string[] }): string {
  return `${shellQuoteArgv([...args.cliInvocation, "update-page"])}`
}

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

export function tasksPaneCommand(
  cliInvocation: readonly string[],
  opts: { readonly initialTaskId?: string } = {},
): string {
  const argv = [...cliInvocation, "tasks"]
  if (opts.initialTaskId) argv.push("--initial-task-id", opts.initialTaskId)
  return shellQuoteArgv(argv)
}

export function opsPaneCommand(args: {
  cwd: string
  taskId: string | undefined
  claudePaneId: string | null
  cliInvocation: readonly string[]
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
