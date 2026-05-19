/**
 * tmux status-line replacement for the in-process TopBar.
 *
 * KOB-213 sprint-1: a static one-shot snapshot of version + branch + PR
 * chip, written once at session bootstrap. Live updates (branch follow,
 * PR auto-detect, plan-usage chips) move under the daemon in a later
 * sprint via `tmux refresh-client -S` or per-pane formatters.
 */

export type TmuxCommand = readonly string[]

export interface StatusLineOptions {
  readonly version: string
  readonly branch: string
  readonly pr?: string
}

export function buildStatusLineCommands(sessionName: string, opts: StatusLineOptions): TmuxCommand[] {
  const left = ` KobeCode v${opts.version} `
  const right = ` ${opts.branch} · PR:${opts.pr ?? "none"} `
  return [
    ["set-option", "-t", sessionName, "status", "on"],
    ["set-option", "-t", sessionName, "status-interval", "0"],
    ["set-option", "-t", sessionName, "status-justify", "centre"],
    ["set-option", "-t", sessionName, "status-style", "fg=white,bg=colour236"],
    ["set-option", "-t", sessionName, "status-left-length", "40"],
    ["set-option", "-t", sessionName, "status-right-length", "60"],
    ["set-option", "-t", sessionName, "status-left", left],
    ["set-option", "-t", sessionName, "status-right", right],
  ]
}
