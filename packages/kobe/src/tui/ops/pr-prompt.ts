import { spawnSync } from "node:child_process"
import { promises as fs } from "node:fs"
import path from "node:path"

export interface PRPromptState {
  readonly branch: string
  readonly targetBranch: string
  readonly hasUpstream: boolean
  readonly dirtyCount: number
}

const GIT_TIMEOUT_MS = 5_000

export const DEFAULT_PR_PROMPT_TEMPLATE = `The user likes the current state of the code.

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

function git(cwd: string, args: readonly string[]): string | null {
  try {
    const out = spawnSync("git", args.slice(), {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
    })
    if (out.error) return null
    if (out.status !== 0) return null
    return (out.stdout ?? "").trim()
  } catch {
    return null
  }
}

function currentBranch(cwd: string): string {
  return git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) || "HEAD"
}

function targetBranch(cwd: string): string {
  const out = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD", "--short"])
  if (!out) return "main"
  return out.startsWith("origin/") ? out.slice("origin/".length) : out
}

function hasUpstream(cwd: string): boolean {
  const out = git(cwd, ["rev-parse", "--abbrev-ref", "@{u}"])
  return out !== null && out.length > 0
}

function dirtyCount(cwd: string): number {
  const out = git(cwd, ["status", "--porcelain"])
  if (!out) return 0
  return out.split("\n").filter((line) => line.length > 0).length
}

export function gatherPRPromptState(worktree: string): PRPromptState {
  return {
    branch: currentBranch(worktree),
    targetBranch: targetBranch(worktree),
    hasUpstream: hasUpstream(worktree),
    dirtyCount: dirtyCount(worktree),
  }
}

function dirtyCountSentence(n: number): string {
  if (n <= 0) return "There are no uncommitted changes."
  if (n === 1) return "There is 1 uncommitted change."
  return `There are ${n} uncommitted changes.`
}

function upstreamSentence(hasUpstreamValue: boolean): string {
  return hasUpstreamValue ? "The current branch tracks an upstream." : "There is no upstream branch yet."
}

export function renderPRPrompt(template: string, state: PRPromptState): string {
  const replacements: Record<string, string> = {
    branch: state.branch,
    targetBranch: state.targetBranch,
    dirtyCountSentence: dirtyCountSentence(state.dirtyCount),
    upstreamSentence: upstreamSentence(state.hasUpstream),
  }
  return template.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (match, key: string) =>
    Object.hasOwn(replacements, key) ? (replacements[key] as string) : match,
  )
}

async function loadTemplate(worktree: string): Promise<string> {
  const file = path.join(worktree, ".kobe", "pr-instructions.md")
  try {
    const text = await fs.readFile(file, "utf8")
    return text.length > 0 ? text : DEFAULT_PR_PROMPT_TEMPLATE
  } catch {
    return DEFAULT_PR_PROMPT_TEMPLATE
  }
}

export async function buildPRPrompt(worktree: string): Promise<string> {
  return renderPRPrompt(await loadTemplate(worktree), gatherPRPromptState(worktree))
}
