/**
 * Top-level kobe subcommands (user-facing) — the source `kobe completions`
 * reads to build its shell completion scripts.
 *
 * This must stay in lock-step with the command list rendered by
 * {@link ./usage.ts}'s `topLevelUsage()` (the `kobe --help` text). That
 * invariant is enforced by a test (`test/cli/usage.test.ts`), so adding or
 * removing a public subcommand fails CI until both lists agree — they are NOT
 * auto-derived from the `index.ts` dispatch, so the test is what catches drift.
 *
 * Internal subcommands fired by tmux key bindings (`new-chattab`,
 * `quick-create`, `quick-task`, `focus-tasks`, `heal-layout`,
 * `capture-layout`, `layout`, `tasks`, `ops`, `hook`) are NOT included —
 * they are not meant for direct use.
 */
export const TOP_LEVEL_SUBCOMMANDS = [
  "web",
  "completions",
  "add",
  "remove",
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
