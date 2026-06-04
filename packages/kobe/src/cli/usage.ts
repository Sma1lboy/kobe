/**
 * Top-level `kobe` CLI help text.
 *
 * Kept as one tested string so `kobe help` / `kobe --help` and the
 * unknown-command path in {@link ./index.ts} render the same thing, and
 * so adding a subcommand updates help in one place.
 */

import { CURRENT_VERSION } from "../version.ts"

/** The full `kobe help` text (no trailing newline). */
export function topLevelUsage(): string {
  return [
    `kobe ${CURRENT_VERSION}`,
    "",
    "Usage: kobe [command] [options]",
    "",
    "Run with no command to launch the TUI.",
    "",
    "Commands:",
    "  add [path]              Save a repo path for the new-task picker",
    "  adopt [glob]            Import existing git worktrees as tasks",
    "  repo <verb>             Per-repo init script + first prompt (show|set|unset)",
    "  api <verb>              Scriptable RPC surface for agents (see `kobe api --help`)",
    "  daemon <verb>           Manage the daemon (start|stop|status|restart)",
    "  theme <verb>            Manage user themes (list|add|remove)",
    "  update [target]         Self-update kobe",
    "  doctor                  Diagnose daemon / tmux / state (read-only)",
    "  reset [--hard]          Recover a wedged install",
    "  reload                  Restart Tasks/Ops panes in place (engine untouched)",
    "  kill-sessions           Tear down kobe's tmux server (dev reset)",
    "",
    "Options:",
    "  -v, --version           Print version",
    "  -h, --help              Print this help",
  ].join("\n")
}
