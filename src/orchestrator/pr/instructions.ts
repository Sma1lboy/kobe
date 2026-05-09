/**
 * PR-instruction template + render helpers.
 *
 * Why this lives here: kobe deliberately does NOT abstract over git
 * providers (gh / glab / bitbucket / etc). Instead, when the user clicks
 * "Create PR", we inject a markdown prompt into the active chat session
 * telling the agent how to create a PR — and the agent's own shell + tool
 * use figures out provider quirks. That moves provider knowledge from
 * kobe's code (where it would rot) to the agent's runtime (where it's
 * already maintained).
 *
 * The default template is plain markdown with `{{...}}` placeholders.
 * `renderPRInstructions` substitutes them. Per-repo customization happens
 * by dropping a file at `<worktreePath>/.kobe/pr-instructions.md`; we
 * read it via `loadPRInstructionsTemplate` (best-effort, falls back to
 * the default on any IO failure so kobe never blocks on user FS oddities).
 */

import { promises as fs } from "node:fs"
import path from "node:path"

/** Tiny snapshot of a worktree's git state, gathered by `gatherPRState`. */
export interface PRState {
  /** Current branch name (or `'HEAD'` if detached). */
  branch: string
  /** Best-effort default branch (origin/HEAD symbolic ref → fallback `'main'`). */
  targetBranch: string
  /** True iff the current branch resolves an `@{u}` upstream. */
  hasUpstream: boolean
  /** Count of porcelain status lines (0 if working tree is clean). */
  dirtyCount: number
}

/**
 * Default markdown template for the PR-creation prompt. Substitutions:
 *
 *   - {{branch}}                — current branch
 *   - {{targetBranch}}          — target branch (PR base)
 *   - {{dirtyCountSentence}}    — pre-rendered uncommitted-changes sentence
 *   - {{upstreamSentence}}      — pre-rendered upstream sentence
 */
export const DEFAULT_PR_INSTRUCTIONS_TEMPLATE = `The user likes the current state of the code.

{{dirtyCountSentence}}
The current branch is {{branch}}.
The target branch is {{targetBranch}}.

{{upstreamSentence}}
The user requested a PR.

Follow these steps to create a PR:

- If you have any skills related to creating PRs, invoke them now. Instructions there should take precedence over these instructions.
- Run \`git diff\` to review uncommitted changes.
- Commit them. Follow any instructions the user gave you about writing commit messages.
- Push to origin.
- Use \`gh pr create --base {{targetBranch}}\` to create a PR onto the target branch. Keep the title under 80 characters. Keep the description under five sentences. Describe not just changes made in this session but ALL changes since the branch diverged from the target.

If any of these steps fail, ask the user for help.`

/**
 * Render the dirty-count sentence. Pluralizes 1 vs n carefully so the
 * generated prompt reads as natural English to the agent.
 */
function dirtyCountSentence(n: number): string {
  if (n <= 0) return "There are no uncommitted changes."
  if (n === 1) return "There is 1 uncommitted change."
  return `There are ${n} uncommitted changes.`
}

/** Render the upstream sentence. */
function upstreamSentence(hasUpstream: boolean): string {
  return hasUpstream ? "The current branch tracks an upstream." : "There is no upstream branch yet."
}

/**
 * Substitute `{{branch}}`, `{{targetBranch}}`, `{{dirtyCountSentence}}`,
 * and `{{upstreamSentence}}` in a template. Unknown `{{...}}` placeholders
 * are left LITERAL — we never throw on them, since user-supplied templates
 * may legitimately reference variables we don't know about (the agent can
 * still read them and ignore).
 */
export function renderPRInstructions(template: string, state: PRState): string {
  const replacements: Record<string, string> = {
    branch: state.branch,
    targetBranch: state.targetBranch,
    dirtyCountSentence: dirtyCountSentence(state.dirtyCount),
    upstreamSentence: upstreamSentence(state.hasUpstream),
  }
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (match, key: string) => {
    if (Object.hasOwn(replacements, key)) {
      return replacements[key] as string
    }
    return match
  })
}

/**
 * Load the PR-instructions template for a worktree.
 *
 * Looks for `<worktreePath>/.kobe/pr-instructions.md`. If it exists and
 * is readable, returns its contents. Otherwise (file missing, permission
 * error, anything) returns the default template — we deliberately swallow
 * IO errors so a malformed user override never blocks the PR flow; the
 * worst case is that the user's custom prompt doesn't apply, which they
 * can debug by reading the rendered prompt that lands in chat.
 */
export async function loadPRInstructionsTemplate(worktreePath: string): Promise<string> {
  if (!worktreePath) return DEFAULT_PR_INSTRUCTIONS_TEMPLATE
  const file = path.join(worktreePath, ".kobe", "pr-instructions.md")
  try {
    const text = await fs.readFile(file, "utf8")
    if (text.length === 0) return DEFAULT_PR_INSTRUCTIONS_TEMPLATE
    return text
  } catch {
    return DEFAULT_PR_INSTRUCTIONS_TEMPLATE
  }
}
