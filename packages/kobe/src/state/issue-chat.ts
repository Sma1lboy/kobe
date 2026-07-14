/**
 * Issue-chat grammar — framework-free placement + first-prompt builders for
 * starting an engine session from a kanban story. Mirrors the web board's
 * quick-start contract (kobe-web/src/lib/issues.ts): the prompt frames the
 * story, and the agent reports completion through the daemon-owned issue API
 * (`issue-set-status`), never by editing repo files.
 *
 * Placements say WHERE the session runs — jump-or-stay is the drawer's
 * separate toggle (`IssueChatStart.jump`), supported by all three:
 *   - `worktree`        — a new worktree task with its own workspace.
 *   - `projectWorktree` — same task creation (worktree + branch + link),
 *                         but the session ALSO appears as a chattab in the
 *                         PROJECT workspace (a viewport tab —
 *                         `EngineTab.ptyTask`): isolated work, presented
 *                         where the project lives.
 *   - `project`         — no worktree: a new chattab on the repo's
 *                         main-task checkout (`task.ensureMain`).
 */

import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { attachmentLabel } from "../tui/lib/attachments"

export type IssueChatPlacement = "worktree" | "projectWorktree" | "project"

/** Next `images[N]:`/`pdf[N]:` placeholder index in a body draft. */
export function nextPlaceholderIndex(body: string): number {
  const matches = body.match(/^(?:images|pdf)\[\d+\]:/gm)
  return matches ? matches.length : 0
}

/**
 * Append `images[N]: /path` placeholder lines for pasted files to a body
 * draft — the description IS the carrier: the lines persist in the issue
 * body and ride the first prompt, where the engine reads the files itself.
 */
export function withImagePlaceholders(body: string, paths: readonly string[]): string {
  let next = body.replace(/\s+$/, "")
  let index = nextPlaceholderIndex(body)
  for (const path of paths) {
    const line = `${attachmentLabel(path, index)}: ${path}`
    next = next.length > 0 ? `${next}\n${line}` : line
    index += 1
  }
  return next
}

/** Drawer order — the isolated task workspace first (kobe's product unit),
 *  then the project-presented variants. Jump/stay is a separate toggle. */
export const ISSUE_CHAT_PLACEMENTS: readonly IssueChatPlacement[] = ["worktree", "projectWorktree", "project"]

/** Task title for a story-spawned task — same `#id title` shape the web uses. */
export function issueChatTaskTitle(issue: Issue): string {
  return `#${issue.id} ${issue.title}`
}

function promptHeader(issue: Issue): string[] {
  const lines = [`Work on user story #${issue.id}: ${issue.title}`, ""]
  const body = issue.body.trim()
  if (body) lines.push(body, "")
  return lines
}

/** First message for a worktree-task session (web quickStartPrompt parity). */
export function issueWorktreePrompt(issue: Issue, api = "kobe api"): string {
  return [
    ...promptHeader(issue),
    "Treat this as the story's dedicated kobe task session: work only in this task worktree, and preserve any repo init instructions already delivered to the session.",
    "Before finishing, verify the acceptance criteria implied by the story and summarize what changed plus any verification still needed.",
    "Then merge the task branch back into the current project's main branch after the worktree is clean and checks pass.",
    `When the work lands, run: ${api} issue-set-status --repo . --id ${issue.id} --status done`,
  ].join("\n")
}

/** First message for a chat directly on the project checkout — no worktree,
 *  so the worktree/merge instructions are replaced with a stay-put note. */
export function issueProjectPrompt(issue: Issue, api = "kobe api"): string {
  return [
    ...promptHeader(issue),
    "You are working directly in the project checkout — no dedicated worktree or branch was created. Keep changes reviewable and do not switch branches unless asked.",
    "Before finishing, verify the acceptance criteria implied by the story and summarize what changed plus any verification still needed.",
    `When the work lands, run: ${api} issue-set-status --repo . --id ${issue.id} --status done`,
  ].join("\n")
}
