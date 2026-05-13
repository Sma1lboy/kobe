import type { AIEngine, OrchestratorEvent, SessionHandle } from "../types/engine"
import type { ChatTab, ModelEffortLevel, Task, TaskId } from "../types/task"
import { CONCURRENCY_CAP, ConcurrencyCapError, IllegalTransitionError } from "./errors"
import type { TaskIndexStore } from "./index/store"
import type { TaskWorktreeCoordinator } from "./task-worktree"
import { deriveTitleFromPrompt } from "./title"

export const PLACEHOLDER_TASK_TITLE = "(new task)"

function tabKey(taskId: string, tabId: string): string {
  return `${taskId}:${tabId}`
}

export class TaskRunner {
  private readonly firstSpawnLatches = new Map<string, Promise<void>>()

  constructor(
    private readonly deps: {
      readonly store: TaskIndexStore
      readonly handles: Map<string, SessionHandle>
      readonly pumps: Map<string, Promise<void>>
      readonly worktrees: TaskWorktreeCoordinator
      readonly resolveTab: (task: Task, tabId?: string) => ChatTab
      readonly dispatchEvent: (taskId: TaskId, tabId: string, ev: OrchestratorEvent) => void
      readonly engineForTab: (task: Task, tab: ChatTab) => AIEngine
      readonly engineForTabRun: (task: Task, tab: ChatTab) => Promise<AIEngine>
      readonly modelForTab: (task: Task, tab: ChatTab, engine: AIEngine) => string
      readonly modelEffortForTab: (task: Task, tab: ChatTab) => ModelEffortLevel | undefined
      readonly updateTab: (taskId: TaskId, tabId: string, patch: Partial<ChatTab>) => Promise<void>
      readonly runPumpAndCleanup: (taskId: TaskId, tabId: string, handle: SessionHandle) => Promise<void>
      readonly bumpRunState: () => void
    },
  ) {}

  async runTask(task: Task, prompt?: string, tabId?: string): Promise<void> {
    let currentTask = task
    if (task.status === "canceled") {
      throw new IllegalTransitionError(task.status, "in_progress", String(task.id))
    }

    const isMain = currentTask.kind === "main"
    const isFirstAllocation = !isMain && !currentTask.worktreePath
    if (isFirstAllocation) {
      currentTask = await this.deps.worktrees.ensureWorktree(currentTask)
      const targetTabForInfo = this.deps.resolveTab(currentTask, tabId)
      this.deps.dispatchEvent(currentTask.id, targetTabForInfo.id, {
        type: "system.info",
        text: `worktree: ${currentTask.worktreePath} (branch ${currentTask.branch})`,
      })
    }
    if (isFirstAllocation && prompt) {
      const renameTabId = this.deps.resolveTab(currentTask, tabId).id
      void this.deps.worktrees.maybeRenameTempBranch(currentTask.id, renameTabId, prompt)
    }

    let targetTab = this.deps.resolveTab(currentTask, tabId)
    const key = tabKey(currentTask.id, targetTab.id)
    if (!targetTab.sessionId) {
      const inflight = this.firstSpawnLatches.get(key)
      if (inflight) {
        await inflight.catch(() => {})
        const fresh = this.deps.store.get(currentTask.id)
        if (fresh) {
          currentTask = fresh
          targetTab = this.deps.resolveTab(currentTask, tabId)
        }
      }
    }

    if (!this.deps.handles.has(key) && this.deps.handles.size >= CONCURRENCY_CAP) {
      throw new ConcurrencyCapError()
    }

    const promptToSend = prompt && prompt.length > 0 ? prompt : " "
    if (prompt && prompt.trim().length > 0) {
      this.deps.dispatchEvent(currentTask.id, targetTab.id, { type: "user.inject", text: prompt })
    }

    const engine = targetTab.sessionId
      ? await this.deps.engineForTabRun(currentTask, targetTab)
      : this.deps.engineForTab(currentTask, targetTab)
    const modelToUse = this.deps.modelForTab(currentTask, targetTab, engine)
    const modelEffortToUse = this.deps.modelEffortForTab(currentTask, targetTab)

    let handle: SessionHandle
    if (targetTab.sessionId) {
      handle = await engine.resume(targetTab.sessionId, promptToSend, {
        cwd: currentTask.worktreePath,
        env: { KOBE_RESUME_CWD: currentTask.worktreePath },
        permissionMode: currentTask.permissionMode,
        model: modelToUse,
        modelEffort: modelEffortToUse,
      })
    } else {
      let releaseLatch: () => void = () => {}
      const latch = new Promise<void>((resolve) => {
        releaseLatch = resolve
      })
      this.firstSpawnLatches.set(key, latch)
      try {
        handle = await engine.spawn(currentTask.worktreePath, promptToSend, {
          permissionMode: currentTask.permissionMode,
          model: modelToUse,
          modelEffort: modelEffortToUse,
        })
        await this.deps.updateTab(currentTask.id, targetTab.id, { sessionId: handle.sessionId })
        if (currentTask.title === PLACEHOLDER_TASK_TITLE && prompt && prompt.trim().length > 0) {
          const derived = deriveTitleFromPrompt(prompt)
          if (derived) await this.deps.store.update(currentTask.id, { title: derived })
        }
        if (prompt && prompt.trim().length > 0) {
          void this.deps.worktrees.maybeUpgradeTitle(currentTask.id, prompt)
        }
      } finally {
        releaseLatch()
        this.firstSpawnLatches.delete(key)
      }
    }

    this.deps.handles.set(key, handle)
    this.deps.bumpRunState()

    if (currentTask.status !== "in_progress") {
      await this.deps.store.update(currentTask.id, { status: "in_progress" })
    }

    const pump = this.deps.runPumpAndCleanup(currentTask.id, targetTab.id, handle)
    this.deps.pumps.set(key, pump)
    pump.catch((err) => {
      this.deps.dispatchEvent(currentTask.id, targetTab.id, {
        type: "error",
        message: `pump failure: ${err instanceof Error ? err.message : String(err)}`,
      })
    })
  }
}
