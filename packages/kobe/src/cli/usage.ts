/**
 * Top-level `kobe` CLI help text.
 *
 * Kept as one tested string so `kobe help` / `kobe --help` and the
 * unknown-command path in {@link ./index.ts} render the same thing, and
 * so adding a subcommand updates help in one place.
 */

/** The full `kobe help` text (no trailing newline). */
export function topLevelUsage(): string {
  return [
    "Usage: kobe [command] [options]",
    "",
    "Run with no command to launch the TUI.",
    "",
    "Commands:",
    "  add [path]              Save a repo path for the new-task picker",
    "  adopt [glob]            Import existing git worktrees as tasks",
    "  api <verb>              Scriptable RPC surface for agents (see `kobe api --help`)",
    "  daemon <verb>           Manage the daemon (start|stop|status|restart)",
    "  theme <verb>            Manage user themes (list|add|remove)",
    "  update [target]         Self-update kobe",
    "  doctor                  Diagnose daemon / tmux / state (read-only)",
    "  reset [--hard]          Recover a wedged install",
    "  kill-sessions           Tear down kobe's tmux server (dev reset)",
    "",
    "Options:",
    "  --daemon                Launch the TUI against a shared daemon",
    "  --single                Launch the TUI with its own daemon",
    "  -v, --version           Print version",
    "  -h, --help              Print this help",
  ].join("\n")
}
