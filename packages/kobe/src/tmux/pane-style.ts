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
    // Enable mouse so the user can click panes / tab-strip chips / scroll.
    // tmux 3.x default is off; without this the sidebar/tab-strip Solid
    // components can't receive any pointer event (they're just text in
    // a tmux pane — only the focused pane sees keystrokes by default).
    ["set-option", "-t", sessionName, "mouse", "on"],
  ]
}
