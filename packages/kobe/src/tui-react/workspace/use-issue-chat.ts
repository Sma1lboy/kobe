/**
 * Issue-chat start wiring (kanban detail drawer → engine session) — the
 * quick-fork pattern generalized to the three issue placements
 * (`state/issue-chat.ts`):
 *
 *   - `worktree`   — create the story's task, link the issue (flips it
 *                    `doing` + arms the daemon's done-mirror), enter it.
 *   - `worktreeBg` — same create+link, then the engine session LAUNCHES
 *                    immediately in the hosted PTY (`tui/workspace/
 *                    issue-chat-spawn.ts`) — the board's trigger: the agent
 *                    starts on the story right away while the user stays on
 *                    the kanban page tracking the card; visiting the task
 *                    later attaches to the same live session (the spawn's
 *                    tab snapshot is persisted under `terminalTabsKey`).
 *   - `project`    — `ensureMainTask` + stamp the chosen vendor on it (the
 *                    engine spec reads task.vendor at spawn), flip the story
 *                    `doing` (no link — the main task never "completes"),
 *                    enter the project workspace.
 *
 * Foreground first-prompt delivery rides `TerminalTabs`' `initialPrompt`
 * prop exactly like quick-fork — the prompt is held here per task id and
 * consumed by the task's first engine spawn. Held in a Map (unlike
 * quick-fork's single slot) so several starts can be pending at once.
 * Image references need no side channel — `images[N]: /path` placeholder
 * lines live in the issue BODY (the detail drawer inserts them on paste),
 * so they ride the prompt as part of the story text.
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
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { buildIssueChatBackgroundSpawn } from "../../tui/workspace/issue-chat-spawn"
import type { Task, VendorId } from "../../types/task"
import { useKV } from "../context/kv"
import { useT } from "../i18n"
import { terminalTabsKey } from "./terminal-tabs-persist"

export interface IssueChatStart {
  readonly repoRoot: string
  /** The story as the drawer left it — edited title/body already saved. */
  readonly issue: Issue
  readonly vendor: VendorId
  readonly placement: IssueChatPlacement
}

export interface IssueChatOrchestrator {
  createTask(input: { repo: string; title?: string; vendor?: VendorId }): Promise<Task>
  ensureMainTask(repo: string): Promise<Task>
  ensureWorktree(id: string): Promise<string>
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
  const kv = useKV()
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
    const { repoRoot, issue, vendor, placement } = request
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
        holdPrompt(main.id, issueProjectPrompt(issue, api))
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
      if (placement === "worktree") {
        holdPrompt(task.id, issueWorktreePrompt(issue, api))
        await enter(task.id)
        return
      }
      // Background trigger: launch the engine session NOW in the hosted PTY
      // (the prompt rides its argv — no held prompt, no first-visit wait).
      // The persisted tab snapshot makes a later visit attach to this
      // session; the kanban card tracks progress via the engine-state
      // channel until the agent self-reports the story done.
      const worktreePath = await orch.ensureWorktree(task.id)
      const spawn = buildIssueChatBackgroundSpawn({
        issue,
        taskId: task.id,
        repoRoot,
        worktreePath,
        vendor,
        api,
      })
      getDefaultPtyRegistry().acquire(spawn.ptyKey, worktreePath, { command: spawn.command })
      kv.set(terminalTabsKey(task.id), spawn.tabsSnapshot)
      hooks.notifyInfo(t("kanban.detail.startedBackground", { title: issueChatTaskTitle(issue) }))
    } catch (err) {
      hooks.notifyError(`Couldn't start issue chat: ${errorMessage(err)}`)
    }
  }

  function initialPromptFor(taskId: string | undefined): string | undefined {
    return taskId ? pending.get(taskId) : undefined
  }

  return { start, initialPromptFor }
}
