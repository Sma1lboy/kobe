/**
 * Top-level kobe subcommands (user-facing).
 *
 * Kept as one array so `kobe completions` and the CLI dispatch can share
 * the same source of truth (and so adding a subcommand updates completions
 * in one place).
 *
 * Internal subcommands fired by tmux key bindings (`new-chattab`,
 * `quick-create`, `quick-task`, `focus-tasks`, `heal-layout`,
 * `capture-layout`, `layout`, `tasks`, `ops`, `hook`) are NOT included —
 * they are not meant for direct use.
 */
export const TOP_LEVEL_SUBCOMMANDS = [
  "web",
  "add",
  "adopt",
  "export",
  "repo",
  "api",
  "daemon",
  "theme",
  "skill",
  "feedback",
  "update",
  "doctor",
  "reset",
  "reload",
  "kill-sessions",
] as const

export type TopLevelSubcommand = (typeof TOP_LEVEL_SUBCOMMANDS)[number]
