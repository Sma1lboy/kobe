import { DEFAULT_VENDOR, resolveVendor } from "./vendor.ts"

const doneClause = (taskId: string): string =>
  `if it passes, run \`kobe api set-status --task-id ${taskId} --status done\`; otherwise report the problems and leave the status unchanged.`

export function defaultReviewTemplate(vendor?: string): string {
  return resolveVendor(vendor) === DEFAULT_VENDOR
    ? "/review"
    : "Review the current changes in this worktree critically."
}

export function reviewPrompt(
  taskId: string,
  vendor?: string,
  template?: string | null,
): string {
  const base = template?.trim() || defaultReviewTemplate(vendor)
  return `${base}\nAfter the review: ${doneClause(taskId)}`
}

export const DEFAULT_PR_TEMPLATE = [
  "Open a pull request for this task's branch:",
  "1. Make sure the work is committed, then push the branch to origin.",
  "2. Create the PR with `gh pr create` — write a clear title and a body that summarizes what changed and why, following this repo's conventions.",
].join("\n")

export function createPrPrompt(template?: string | null): string {
  const base = template?.trim() || DEFAULT_PR_TEMPLATE
  return [
    base,
    "Reply with the PR URL.",
    "If `gh` isn't authenticated, there's no remote, or a PR already exists for this branch, say so instead of forcing it.",
  ].join("\n")
}
