/**
 * Issue-chat start wiring (kanban detail drawer → engine session). The
 * placement says WHERE the session runs; `jump` says whether the user
 * follows it or stays on the board — every combination LAUNCHES the engine
 * immediately in the hosted PTY (`tui/workspace/issue-chat-spawn.ts`), so
 * "start" always means the agent is working, and a jump merely attaches to
 * the already-running session:
 *
 *   - `worktree`        — create the story's task + link the issue (the
 *                         link stamps issue.taskId, flips it `doing`, arms
 *                         the daemon's done-mirror), spawn its tab-1
 *                         session headlessly, persist the tab snapshot.
 *                         Jump = enter the task's workspace.
 *   - `projectWorktree` — same task/spawn as `worktree`, PLUS a viewport
 *                         tab (`EngineTab.ptyTask`) appended to the repo's
 *                         MAIN workspace strip: isolated work, presented in
 *                         the project. Jump = enter the project workspace
 *                         (the viewport tab is active).
 *   - `project`         — no worktree: a NEW chattab appended to the main
 *                         workspace, running on the project checkout with
 *                         the story prompt riding its spawn (a busy tab-1
 *                         can no longer swallow the prompt). Jump = enter
 *                         the project workspace.
 *
 * Image references need no side channel — `images[N]: /path` placeholder
 * lines live in the issue BODY (the detail drawer inserts them on paste),
 * so they ride the prompt as part of the story text.
 */

import { errorMessage } from "@/lib/error-message"
import type { Issue } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import { kobeApiInvocation } from "../../engine/interactive-command"
import {
  type IssueChatPlacement,
  issueChatTaskTitle,
  issueProjectPrompt,
  issueWorktreePrompt,
} from "../../state/issue-chat"
import { addSavedRepo } from "../../state/repos"
import { setRepoLastActiveVendor } from "../../state/vendor-prefs"
import { defaultShell } from "../../tui/panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { buildIssueChatBackgroundSpawn, buildIssueTabSpawn } from "../../tui/workspace/issue-chat-spawn"
import type { EngineTab } from "../../tui/workspace/terminal-tabs-core"
import type { Task, VendorId } from "../../types/task"
import { useKV } from "../context/kv"
import { useT } from "../i18n"
import { terminalTabsKey } from "./terminal-tabs-persist"
import { appendBackgroundEngineTab } from "./terminal-tabs-store"

export interface IssueChatStart {
  readonly repoRoot: string
  /** The story as the drawer left it — edited title/body already saved. */
  readonly issue: Issue
  readonly vendor: VendorId
  readonly placement: IssueChatPlacement
  /** Follow the session (enter its workspace) or stay on the board. */
  readonly jump: boolean
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
}

export function useIssueChat(
  orch: IssueChatOrchestrator,
  hooks: {
    selectTask: (id: string) => void
    enterTask: (id: string) => Promise<void>
    /** Close the kanban page before landing on the session's workspace. */
    closeKanban: () => void
    notifyError: (message: string) => void
    /** Feedback for a stay-on-the-board start. */
    notifyInfo: (message: string) => void
  },
): UseIssueChatResult {
  const t = useT()
  const kv = useKV()

  async function enter(taskId: string): Promise<void> {
    hooks.closeKanban()
    hooks.selectTask(taskId)
    await hooks.enterTask(taskId)
  }

  async function finish(request: IssueChatStart, enterTaskId: string): Promise<void> {
    if (request.jump) await enter(enterTaskId)
    else hooks.notifyInfo(t("kanban.detail.startedBackground", { title: issueChatTaskTitle(request.issue) }))
  }

  /** Append a story chattab to the repo's MAIN workspace and spawn it (the
   *  `project` placement — the story runs on the project checkout). */
  async function startProjectTab(request: IssueChatStart, api: string): Promise<void> {
    const { repoRoot, issue, vendor } = request
    const main = await orch.ensureMainTask(repoRoot)
    // Vendor lands on the task for future tabs; the story flip is
    // best-effort (a status write must not strand the chat).
    await orch.setVendor(main.id, vendor)
    await orch
      .mutateIssue(repoRoot, { type: "setStatus", id: issue.id, status: "doing" })
      .catch((err: unknown) => console.error("[kobe kanban] issue setStatus failed:", err))
    const { tab } = appendBackgroundEngineTab(kv, main.id, defaultShell(), { vendor })
    const spawn = buildIssueTabSpawn({
      taskId: main.id,
      repoRoot,
      worktreePath: main.worktreePath,
      tab,
      vendor,
      prompt: issueProjectPrompt(issue, api),
    })
    getDefaultPtyRegistry().acquire(spawn.ptyKey, main.worktreePath, { command: spawn.command })
    await finish(request, main.id)
  }

  /** Create + link the story's task and spawn its tab-1 session headlessly
   *  (both worktree placements share this half). */
  async function startWorktreeTask(
    request: IssueChatStart,
    api: string,
  ): Promise<{ task: Task; worktreePath: string; tab: EngineTab }> {
    const { repoRoot, issue, vendor } = request
    setRepoLastActiveVendor(repoRoot, vendor)
    addSavedRepo(repoRoot)
    const task = await orch.createTask({ repo: repoRoot, title: issueChatTaskTitle(issue), vendor })
    await orch
      .mutateIssue(repoRoot, { type: "link", id: issue.id, taskId: task.id })
      .catch((err: unknown) => console.error("[kobe kanban] issue link failed:", err))
    const worktreePath = await orch.ensureWorktree(task.id)
    const spawn = buildIssueChatBackgroundSpawn({ issue, taskId: task.id, repoRoot, worktreePath, vendor, api })
    getDefaultPtyRegistry().acquire(spawn.ptyKey, worktreePath, { command: spawn.command })
    kv.set(terminalTabsKey(task.id), spawn.tabsSnapshot)
    return { task, worktreePath, tab: spawn.tabsSnapshot.tabs[0] as EngineTab }
  }

  async function start(request: IssueChatStart): Promise<void> {
    try {
      const api = kobeApiInvocation()
      if (request.placement === "project") {
        await startProjectTab(request, api)
        return
      }
      const { task, worktreePath, tab } = await startWorktreeTask(request, api)
      if (request.placement === "projectWorktree") {
        // Present the running session as a viewport tab in the PROJECT
        // workspace — same PTY key, the task's worktree as cwd. Workspaces
        // render one at a time, so the two views attach sequentially.
        const main = await orch.ensureMainTask(request.repoRoot)
        appendBackgroundEngineTab(kv, main.id, defaultShell(), {
          vendor: request.vendor,
          sessionId: tab.sessionId ?? null,
          ptyTask: { id: task.id, worktree: worktreePath },
        })
        await finish(request, main.id)
        return
      }
      await finish(request, task.id)
    } catch (err) {
      hooks.notifyError(`Couldn't start issue chat: ${errorMessage(err)}`)
    }
  }

  return { start }
}
