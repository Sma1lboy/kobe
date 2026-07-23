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
    "Run with no command to launch PureTUI.",
    "Run `kobe .` (or `kobe <path>`) to open a directory as a standalone task.",
    "",
    "Commands:",
    "  web [options]           Launch the browser dashboard",
    "  completions <shell>     Generate shell completion script (bash/zsh/fish)",
    "  add [path]              Save a repo path for the new-task picker",
    "  remove [path]           Forget a saved project (inverse of add; non-destructive)",
    "  adopt [glob]            Import existing git worktrees as tasks",
    "  export [--csv|--json]   Print the task list (json/csv/table; daemon-free)",
    "  repo <verb>             Per-repo init script + first prompt (show|set|unset)",
    "  api <verb>              Scriptable RPC surface for agents (see `kobe api --help`)",
    "  daemon <verb>           Manage the daemon (start|stop|status|restart)",
    "  doctor [--report]        Diagnose daemon/PTY/engines/git; --report writes a bundle",
    "  config [--path]          Open kobe's config file (state.json) in your editor",
    "  reset [--hard]           Stop runtimes; optionally wipe task/UI state",
    "  theme <verb>            Manage user themes (list|add|remove)",
    "  skill <verb>            Install the kobe agent skill (install|status|command)",
    "  feedback                Send feedback to GitHub Discussions",
    "  update [version|list]   Self-update kobe, or browse versions with `list`",
    "",
    "Options:",
    "  -v, --version           Print version",
    "  -h, --help              Print this help",
  ].join("\n")
}
