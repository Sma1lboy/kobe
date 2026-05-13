/**
 * Local-merge prompt template + render helpers.
 *
 * `M` is intentionally local-only: it asks the agent to merge the selected
 * task worktree back into the parent repo checkout. PR creation stays on the
 * existing PR flow.
 */

export interface LocalMergeState {
  /** Selected task title, for human context in the prompt. */
  title: string
  /** Source task worktree path. */
  sourceWorktree: string
  /** Source branch name, or HEAD if detached / unknown. */
  sourceBranch: string
  /** Parent repo checkout path: the local merge target. */
  targetRepo: string
  /** Target checkout's current branch, or HEAD if detached / unknown. */
  targetBranch: string
  /** Count of porcelain status lines in the source worktree. */
  sourceDirtyCount: number
  /** Count of porcelain status lines in the target checkout. */
  targetDirtyCount: number
}

export const DEFAULT_LOCAL_MERGE_INSTRUCTIONS_TEMPLATE = `The user pressed M in kobe. This means LOCAL MERGE, not PR.

Task: {{title}}

Source task worktree:
{{sourceWorktree}}

Source branch: {{sourceBranch}}

Target parent repo checkout:
{{targetRepo}}

Target branch: {{targetBranch}}

{{sourceDirtyCountSentence}}
{{targetDirtyCountSentence}}

Please merge the task worktree back into the target parent repo checkout.

Rules:

- Do not create a pull request.
- Do not delete the task worktree or branch.
- Treat the target parent repo checkout as the place where the merge lands.
- First inspect git state in BOTH the source worktree and the target checkout.
- If the target checkout has unrelated dirty changes, explain the risk before modifying them.
- Prefer the repo's existing merge policy when obvious from git history or project docs.
- Resolve conflicts directly when you can do so confidently.
- Run the relevant validation commands after the merge.
- Summarize the merge result, validation results, and any files that still need user attention.`

function countSentence(prefix: string, n: number): string {
  if (n <= 0) return `${prefix} has no uncommitted changes.`
  if (n === 1) return `${prefix} has 1 uncommitted change.`
  return `${prefix} has ${n} uncommitted changes.`
}

export function renderLocalMergeInstructions(template: string, state: LocalMergeState): string {
  const replacements: Record<string, string> = {
    title: state.title,
    sourceWorktree: state.sourceWorktree,
    sourceBranch: state.sourceBranch,
    targetRepo: state.targetRepo,
    targetBranch: state.targetBranch,
    sourceDirtyCountSentence: countSentence("The source worktree", state.sourceDirtyCount),
    targetDirtyCountSentence: countSentence("The target checkout", state.targetDirtyCount),
  }
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (match, key: string) => {
    if (Object.hasOwn(replacements, key)) return replacements[key] as string
    return match
  })
}
