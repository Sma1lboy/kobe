/**
 * The board's one-click review instruction: clicking Review on an
 * `in_review` card pastes this into the task's engine session.
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

export function reviewPrompt(taskId: string, vendor?: string): string {
  if ((vendor ?? "claude") === "claude") {
    return `/review\nAfter the review: ${doneClause(taskId)}`
  }
  return `Review the current changes in this worktree critically. Then: ${doneClause(taskId)}`
}
