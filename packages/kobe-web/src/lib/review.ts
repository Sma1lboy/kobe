/**
 * The board's one-click quick-action instructions, pasted into the task's
 * engine session via /pty/send: Review on `in_review` cards, Open-PR on
 * `done` cards.
 *
 * Deliberately minimal — claude ships its own `/review` command, so the
 * paste leads with that and adds ONLY the thing the engine can't know:
 * the one-time `done` authorization. (The spawn-time status protocol never
 * grants `done`; clicking Review IS the human gate, so the authorization
 * travels with the click. A session never sent a review request can't
 * reach `done` on its own.) Engines without a /review command get a
 * one-line prose ask instead.
 */

const doneClause = (taskId: string): string =>
  `if it passes, run \`kobe api set-status --task-id ${taskId} --status done\`; otherwise report the problems and leave the status unchanged.`

/** Built-in review template when the user hasn't set one (vendor-aware:
 *  claude has a native /review command, others get a prose ask). */
export function defaultReviewTemplate(vendor?: string): string {
  return (vendor ?? "claude") === "claude"
    ? "/review"
    : "Review the current changes in this worktree critically."
}

/**
 * Compose the review instruction: the TEMPLATE half is user-editable
 * (Settings → Board quick actions, stored host-side in state.json), the
 * CLAUSE half is kobe's and is always APPENDED after it — however the
 * template is rewritten, the click-scoped `done` authorization and the
 * leave-unchanged rule can't be edited away.
 */
export function reviewPrompt(
  taskId: string,
  vendor?: string,
  template?: string | null,
): string {
  const base = template?.trim() || defaultReviewTemplate(vendor)
  return `${base}\nAfter the review: ${doneClause(taskId)}`
}

/** Built-in PR template when the user hasn't set one. */
export const DEFAULT_PR_TEMPLATE = [
  "Open a pull request for this task's branch:",
  "1. Make sure the work is committed, then push the branch to origin.",
  "2. Create the PR with `gh pr create` — write a clear title and a body that summarizes what changed and why, following this repo's conventions.",
].join("\n")

/**
 * The done card's "open a PR" instruction. Delegated to the session on
 * purpose: the agent that DID the work writes the PR title/body from its
 * own context — something a generic bridge-side `gh pr create` could never
 * produce — and it follows the repo's own PR conventions because it's
 * sitting in the repo. Same template + appended-clause split as
 * {@link reviewPrompt}.
 */
export function createPrPrompt(template?: string | null): string {
  const base = template?.trim() || DEFAULT_PR_TEMPLATE
  return [
    base,
    "Reply with the PR URL.",
    "If `gh` isn't authenticated, there's no remote, or a PR already exists for this branch, say so instead of forcing it.",
  ].join("\n")
}
