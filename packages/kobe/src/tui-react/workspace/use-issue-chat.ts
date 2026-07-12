/**
 * Issue-chat start wiring (kanban detail drawer → engine session) — the
 * quick-fork pattern generalized to the three issue placements
 * (`state/issue-chat.ts`):
 *
 *   - `worktree`   — create the story's task, link the issue (flips it
 *                    `doing` + arms the daemon's done-mirror), enter it.
 *   - `worktreeBg` — same create+link, but NO activation: the task shows up
 *                    under its project group in the sidebar and the prompt
 *                    waits for the first visit.
 *   - `project`    — `ensureMainTask` + stamp the chosen vendor on it (the
 *                    engine spec reads task.vendor at spawn), flip the story
 *                    `doing` (no link — the main task never "completes"),
 *                    enter the project workspace.
 *
 * First-prompt delivery rides `TerminalTabs`' `initialPrompt` prop exactly
 * like quick-fork — the prompt is held here per task id and consumed by the
 * task's first engine spawn, so a background start delivers on first visit.
 * Held in a Map (unlike quick-fork's single slot): background starts can
 * accumulate several pending prompts.
 */

import { errorMessage } from "@/lib/error-message"
import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { useState } from "react"
import { kobeApiInvocation } from "../../engine/interactive-command"
import {
  type IssueChatPlacement,
  issueChatTaskTitle,
  issueProjectPrompt,
  issueWorktreePrompt,
} from "../../state/issue-chat"
import { addSavedRepo } from "../../state/repos"
import { setRepoLastActiveVendor } from "../../state/vendor-prefs"
import { appendAttachmentRefs } from "../../tui/lib/attachments"
import type { Task, VendorId } from "../../types/task"
import { useT } from "../i18n"

export interface IssueChatStart {
  readonly repoRoot: string
  readonly issue: Issue
  readonly vendor: VendorId
  readonly placement: IssueChatPlacement
  readonly attachments: readonly string[]
}

export interface IssueChatOrchestrator {
  createTask(input: { repo: string; title?: string; vendor?: VendorId }): Promise<Task>
  ensureMainTask(repo: string): Promise<Task>
  setVendor(id: string, vendor: VendorId): Promise<void>
  mutateIssue(repoRoot: string, op: unknown): Promise<unknown>
}

export interface UseIssueChatResult {
  /** Kanban detail drawer's start action. Errors surface via `notifyError`. */
  readonly start: (request: IssueChatStart) => Promise<void>
  /** Pass into ShowWorkspace's `initialPrompt` (alongside quick-fork's). */
  readonly initialPromptFor: (taskId: string | undefined) => string | undefined
}

export function useIssueChat(
  orch: IssueChatOrchestrator,
  hooks: {
    selectTask: (id: string) => void
    enterTask: (id: string) => Promise<void>
    /** Close the kanban page before landing on the session's workspace. */
    closeKanban: () => void
    notifyError: (message: string) => void
    /** Feedback for a background start (the user stays on the board). */
    notifyInfo: (message: string) => void
  },
): UseIssueChatResult {
  const t = useT()
  const [pending, setPending] = useState<ReadonlyMap<string, string>>(new Map())

  function holdPrompt(taskId: string, prompt: string): void {
    setPending((prev) => new Map(prev).set(taskId, prompt))
  }

  async function enter(taskId: string): Promise<void> {
    hooks.closeKanban()
    hooks.selectTask(taskId)
    await hooks.enterTask(taskId)
  }

  async function start(request: IssueChatStart): Promise<void> {
    const { repoRoot, issue, vendor, placement, attachments } = request
    try {
      const api = kobeApiInvocation()
      if (placement === "project") {
        const main = await orch.ensureMainTask(repoRoot)
        // Vendor must land on the task BEFORE the engine spawns — the spec
        // reads task.vendor. The story flip is best-effort (a status write
        // must not strand the chat), the setVendor is not.
        await orch.setVendor(main.id, vendor)
        await orch
          .mutateIssue(repoRoot, { type: "setStatus", id: issue.id, status: "doing" })
          .catch((err: unknown) => console.error("[kobe kanban] issue setStatus failed:", err))
        holdPrompt(main.id, appendAttachmentRefs(issueProjectPrompt(issue, api), attachments))
        await enter(main.id)
        return
      }
      // Both worktree placements: create the story's task + link it (the
      // link stamps issue.taskId, flips it `doing`, and arms the daemon's
      // done-mirror). Link is best-effort — the task already exists.
      setRepoLastActiveVendor(repoRoot, vendor)
      addSavedRepo(repoRoot)
      const task = await orch.createTask({ repo: repoRoot, title: issueChatTaskTitle(issue), vendor })
      await orch
        .mutateIssue(repoRoot, { type: "link", id: issue.id, taskId: task.id })
        .catch((err: unknown) => console.error("[kobe kanban] issue link failed:", err))
      holdPrompt(task.id, appendAttachmentRefs(issueWorktreePrompt(issue, api), attachments))
      if (placement === "worktree") {
        await enter(task.id)
      } else {
        hooks.notifyInfo(t("kanban.detail.startedBackground", { title: issueChatTaskTitle(issue) }))
      }
    } catch (err) {
      hooks.notifyError(`Couldn't start issue chat: ${errorMessage(err)}`)
    }
  }

  function initialPromptFor(taskId: string | undefined): string | undefined {
    return taskId ? pending.get(taskId) : undefined
  }

  return { start, initialPromptFor }
}
