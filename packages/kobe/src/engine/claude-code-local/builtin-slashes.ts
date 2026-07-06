// AUTO-GENERATED from refs/claude-code/src/commands/ — see
// scripts/extract-claude-code-commands.mjs. Do not hand-edit; rerun the
// extractor when you sync the refs/ snapshot.
//
// Filtered to commands that work in `claude -p` (non-interactive)
// mode: dropped 52 local-jsx + 9 non-interactive-disabled.
export type BuiltinSlash = {
  readonly name: string
  readonly description: string
  readonly aliases?: readonly string[]
}

export const BUILTIN_CLAUDE_SLASHES: readonly BuiltinSlash[] = [
  { name: "advisor", description: "Configure the advisor model" },
  { name: "bridge-kick", description: "Inject bridge failure states for manual recovery testing" },
  { name: "commit", description: "Create a git commit" },
  { name: "commit-push-pr", description: "Commit, push, and open a PR" },
  {
    name: "compact",
    description:
      "Clear conversation history but keep a summary in context. Optional: /compact [instructions for summarization]",
  },
  { name: "cost", description: "Show the total cost and duration of the current session" },
  { name: "files", description: "List all files currently in context" },
  { name: "init", description: "" },
  { name: "init-verifiers", description: "Create verifier skill(s) for automated verification of code changes" },
  { name: "install", description: "Install Claude Code native build" },
  { name: "pr-comments", description: "Get comments from a GitHub pull request" },
  { name: "project_areas", description: "Generate a report analyzing your Claude Code sessions" },
  { name: "release-notes", description: "View release notes" },
  { name: "review", description: "Review a pull request" },
  { name: "security-review", description: "Complete a security review of the pending changes on the current branch" },
  { name: "version", description: "Print the version this session is running (not what autoupdate downloaded)" },
] as const
