/**
 * The board's one-click review instruction (docs/design/web-kanban.md M5
 * follow-up): clicking Review on an `in_review` card pastes this prompt
 * into the task's engine session.
 *
 * The `done` authorization travels WITH the click, deliberately: the
 * spawn-time status protocol only ever lets the agent self-report
 * `in_review` — `done` stays human-gated. Clicking Review IS that human
 * gate (the user explicitly delegates the review), so the prompt carries a
 * one-time authorization to set `done` on a passing review. A session that
 * was never sent a review request can never reach `done` on its own.
 */

export function reviewPrompt(taskId: string): string {
  return [
    "Please review the work in this worktree now:",
    "1. Inspect the current changes (`git status`, `git diff`, recent commits on this branch) and any open PR.",
    "2. Verify the work actually does what was asked — run the relevant tests/build/lint where applicable, and read the changed code critically.",
    `3. If the review PASSES: run \`kobe api set-status --task-id ${taskId} --status done\` and reply with a short summary of what you verified.`,
    "4. If anything fails or looks incomplete: do NOT change the status — explain exactly what is wrong and what still needs to happen.",
    "This review request is your one-time authorization to set status `done`; outside an explicit review request, never set `done`.",
  ].join("\n")
}
