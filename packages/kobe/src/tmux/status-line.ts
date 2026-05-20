/**
 * tmux status-line replacement for the in-process TopBar.
 *
 * Sprint-8 styling pass — neutral dark bg (colour234), light fg
 * (colour250), green-accented version on the left chip, neutral
 * branch + PR pair on the right. Static one-shot snapshot written at
 * session bootstrap; live updates (branch follow, PR auto-detect,
 * plan-usage chips) move under the daemon in a later sprint via
 * `tmux refresh-client -S` or per-pane formatters.
 */

export type TmuxCommand = readonly string[]

export interface StatusLineOptions {
  readonly version: string
  readonly branch: string
  readonly pr?: string
}

export function buildStatusLineCommands(sessionName: string, opts: StatusLineOptions): TmuxCommand[] {
  // tmux #[fg=...] escapes are inline format directives — they let us
  // accent the version chip without colouring the whole status bar.
  const left = ` kobe #[fg=colour114,bold]v${opts.version}#[default] `
  const right = ` ${opts.branch} · PR:${opts.pr ?? "none"} `
  return [
    ["set-option", "-t", sessionName, "status", "on"],
    ["set-option", "-t", sessionName, "status-interval", "0"],
    ["set-option", "-t", sessionName, "status-justify", "centre"],
    ["set-option", "-t", sessionName, "status-style", "fg=colour250,bg=colour234"],
    ["set-option", "-t", sessionName, "status-left-length", "40"],
    ["set-option", "-t", sessionName, "status-right-length", "60"],
    ["set-option", "-t", sessionName, "status-left", left],
    ["set-option", "-t", sessionName, "status-right", right],
  ]
}
