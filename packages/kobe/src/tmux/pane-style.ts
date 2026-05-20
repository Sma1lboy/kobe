/**
 * Sprint-8 — pane border styling commands.
 *
 * kobe owns its own pane headers via the Solid components inside each
 * subprocess, so the tmux-drawn pane-border-status string is turned
 * off. The remaining border line is styled subtly (muted grey for
 * inactive, agent-deck-ish green for the focused pane) so the user
 * can still tell which pane has focus without it dominating the
 * visual hierarchy.
 */

export type TmuxCommand = readonly string[]

export function buildPaneStyleCommands(sessionName: string): TmuxCommand[] {
  return [
    ["set-option", "-t", sessionName, "pane-border-status", "off"],
    ["set-option", "-t", sessionName, "pane-border-style", "fg=colour240"],
    ["set-option", "-t", sessionName, "pane-active-border-style", "fg=colour114"],
  ]
}
