import type { EngineMap } from "../engine/registry.ts"
import type { SessionUsageMetrics } from "../session/usage-metrics.ts"
import type {
  AIEngine,
  BackgroundAgent,
  EngineHistory,
  Message,
  ModelEffortLevel,
  SessionMeta,
} from "../types/engine.ts"
import { type ChatTab, DEFAULT_TASK_VENDOR, type Task, type TaskId, type VendorId } from "../types/task.ts"
import type { TaskIndexStore } from "./index/store.ts"

export interface EngineRouterDeps {
  readonly engine?: AIEngine
  readonly engines?: EngineMap
  readonly store: TaskIndexStore
  readonly onTabVendorResolved?: (taskId: TaskId, tabId: string, vendor: VendorId) => Promise<void>
}

export interface EngineWithHistory {
  readonly engine: AIEngine
  readonly vendor?: VendorId
  readonly history?: EngineHistory
}

/**
 * Owns the vendor/session lookup rules for the orchestrator.
 *
 * `core.ts` still owns task lifecycle and persistence mutations; this class
 * only answers "which engine should handle this task/tab/session?" and wraps
 * history/session reads in the same defensive fallbacks the orchestrator had
 * inline before extraction.
 */
export class EngineRouter {
  private readonly engines: Partial<Record<VendorId, AIEngine>>
  private readonly fallbackEngine: AIEngine
  private readonly store: TaskIndexStore
  private readonly onTabVendorResolved?: (taskId: TaskId, tabId: string, vendor: VendorId) => Promise<void>

  constructor(deps: EngineRouterDeps) {
    const built: Partial<Record<VendorId, AIEngine>> = {}
    let fallback: AIEngine | undefined
    if (deps.engines) {
      for (const [vendor, eng] of Object.entries(deps.engines) as Array<[VendorId, AIEngine | undefined]>) {
        if (!eng) continue
        built[vendor] = eng
        fallback ??= eng
      }
    }
    if (deps.engine) {
      const v = deps.engine.capabilities.vendorId
      built[v] ??= deps.engine
      fallback ??= deps.engine
    }
    if (!fallback) {
      throw new Error(
        "Orchestrator: no usable engine found; both deps.engine and deps.engines were examined but contained no valid engines.",
      )
    }
    this.engines = built
    this.fallbackEngine = fallback
    this.store = deps.store
    this.onTabVendorResolved = deps.onTabVendorResolved
  }

  /**
   * Resolve the engine for a given vendor. Falls back when the vendor is not
   * registered, which is defensive against hand-edited or newer task manifests.
   */
  engineForVendor(vendor: VendorId | undefined): AIEngine {
    const v = vendor ?? DEFAULT_TASK_VENDOR
    return this.engines[v] ?? this.fallbackEngine
  }

  fallback(): AIEngine {
    return this.fallbackEngine
  }

  engineForTask(task: Task): AIEngine {
    return this.engineForVendor(task.vendor)
  }

  vendorForTab(task: Task, tab: ChatTab): VendorId {
    return tab.vendor ?? task.vendor ?? DEFAULT_TASK_VENDOR
  }

  modelForTab(task: Task, tab: ChatTab, engine: AIEngine): string {
    return tab.model ?? task.model ?? engine.capabilities.defaultModelId()
  }

  modelEffortForTab(task: Task, tab: ChatTab): ModelEffortLevel | undefined {
    return tab.modelEffort ?? task.modelEffort
  }

  engineForTab(task: Task, tab: ChatTab): AIEngine {
    return this.engineForVendor(this.vendorForTab(task, tab))
  }

  async engineForTabRun(task: Task, tab: ChatTab): Promise<AIEngine> {
    if (!tab.sessionId || tab.vendor) return this.engineForTab(task, tab)
    const resolved = await this.findEngineWithHistory(tab.sessionId, this.vendorForTab(task, tab))
    if (resolved.vendor && resolved.vendor !== tab.vendor) {
      await this.onTabVendorResolved?.(task.id, tab.id, resolved.vendor)
    }
    return resolved.engine
  }

  async findEngineWithHistory(sessionId: string, preferredVendor?: VendorId): Promise<EngineWithHistory> {
    const candidates: Array<[VendorId | undefined, AIEngine]> = []
    if (preferredVendor) candidates.push([preferredVendor, this.engineForVendor(preferredVendor)])
    for (const [vendor, engine] of Object.entries(this.engines) as Array<[VendorId, AIEngine | undefined]>) {
      if (!engine || vendor === preferredVendor) continue
      candidates.push([vendor, engine])
    }
    if (candidates.length === 0) candidates.push([undefined, this.fallbackEngine])

    let fallback = candidates[0] ?? [undefined, this.fallbackEngine]
    let fallbackHistory: EngineHistory | undefined
    for (const [vendor, engine] of candidates) {
      try {
        const history = await engine.readHistory(sessionId)
        if (!fallbackHistory) {
          fallback = [vendor, engine]
          fallbackHistory = history
        }
        if (history.messages.length > 0 || history.usageMetrics) return { engine, vendor, history }
      } catch {
        // Try the next registered engine; a missing/corrupt transcript
        // in one adapter should not hide a session owned by another.
      }
    }
    return { engine: fallback[1], vendor: fallback[0], history: fallbackHistory }
  }

  engineForTaskId(taskId: TaskId): AIEngine {
    const task = this.store.get(taskId)
    return task ? this.engineForTask(task) : this.fallbackEngine
  }

  engineForTaskTabId(taskId: TaskId, tabId: string): AIEngine {
    const task = this.store.get(taskId)
    if (!task) return this.fallbackEngine
    const tab = task.tabs.find((t) => t.id === tabId)
    return tab ? this.engineForTab(task, tab) : this.engineForTask(task)
  }

  engineForSessionId(sessionId: string): AIEngine {
    for (const task of this.store.list()) {
      for (const tab of task.tabs) {
        if (tab.sessionId === sessionId) return this.engineForTab(task, tab)
      }
      if (task.sessionId === sessionId) return this.engineForTask(task)
    }
    return this.fallbackEngine
  }

  async readHistory(sessionId: string): Promise<Message[]> {
    return (await this.readHistoryWithMetrics(sessionId)).messages
  }

  async readHistoryWithMetrics(
    sessionId: string,
  ): Promise<{ messages: Message[]; usageMetrics?: SessionUsageMetrics }> {
    const preferred = this.engineForSessionId(sessionId)
    const { history } = await this.findEngineWithHistory(sessionId, preferred.capabilities.vendorId)
    if (!history) return { messages: [] }
    const messages = [...history.messages]
    const usageMetrics = history.usageMetrics
    return {
      messages,
      ...(usageMetrics ? { usageMetrics } : {}),
    }
  }

  async listSessions(task: Task, tab: ChatTab): Promise<SessionMeta[]> {
    if (!task.worktreePath) return []
    const preferredVendor = this.vendorForTab(task, tab)
    const vendors = new Set<VendorId>()
    vendors.add(preferredVendor)
    for (const vendor of Object.keys(this.engines) as VendorId[]) vendors.add(vendor)

    const out: SessionMeta[] = []
    for (const vendor of vendors) {
      const engine = this.engineForVendor(vendor)
      try {
        const sessions = await engine.listSessions(task.worktreePath)
        for (const session of sessions) out.push({ ...session, vendor })
      } catch {
        // Per-engine best-effort: a missing/unauthed adapter should not
        // hide sessions from another account engine.
      }
    }
    out.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return out
  }

  async listBackgroundAgents(task: Task, tab: ChatTab): Promise<BackgroundAgent[]> {
    if (!task.worktreePath) return []
    const engine = this.engineForTab(task, tab)
    return engine.listBackgroundAgents(task.worktreePath)
  }

  async startBackgroundAgent(task: Task, tab: ChatTab, prompt: string): Promise<BackgroundAgent | null> {
    if (!task.worktreePath) throw new Error("Task has no worktree path")
    const engine = this.engineForTab(task, tab)
    return engine.startBackgroundAgent(task.worktreePath, prompt, {
      model: this.modelForTab(task, tab, engine),
      modelEffort: this.modelEffortForTab(task, tab),
      permissionMode: task.permissionMode,
      cwd: task.worktreePath,
    })
  }
}
