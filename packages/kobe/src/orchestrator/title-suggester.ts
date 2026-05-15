/**
 * Title-suggestion lifecycle for tasks.
 *
 * The default task title comes from {@link deriveTitleFromPrompt} (first
 * ~40 chars of the first user prompt). After enough user turns we ask the
 * engine for a better title via {@link MetadataSuggester}. This module
 * owns all the per-task / per-tab bookkeeping that decides "is it time
 * to upgrade?" so the orchestrator doesn't carry six side maps.
 *
 * Lifecycle:
 *  - {@link recordTurn} — called from TaskRunner before each prompt
 *    submission. Stashes the user prompt and (when applicable) seeds the
 *    fallback candidate — the simple derived title we're allowed to
 *    upgrade later.
 *  - {@link onTurnDone} — called from runPumpAndCleanup after the engine
 *    signals `done`. If the tab had a pending turn AND we have ≥ N user
 *    prompts AND the user hasn't renamed the task, asks the suggester
 *    for a real title and writes it through the store.
 *  - {@link noteUserRename} — called from setTitle. The user picked a
 *    title manually, so suppress future suggestions for this task.
 *  - {@link clearTab} / {@link clearTask} — called by closeTab / clearTab
 *    / deleteTask to drop bookkeeping for tabs/tasks that disappear.
 *
 * Not persisted — every entry is per-process. A restart resets every
 * task's attempted flag, which is fine: the worst case is one extra
 * suggestion attempt per cold start.
 */

import { tabKey, tabKeyMatchesTask } from "../types/tab-key.ts"
import type { ChatTab, Task, TaskId } from "../types/task.ts"
import type { TaskIndexStore } from "./index/store.ts"
import type { MetadataSuggester, MetadataSuggestionContext } from "./metadata-suggester.ts"
import { PLACEHOLDER_TASK_TITLE } from "./run-task.ts"
import { deriveTitleFromPrompt } from "./title.ts"

const MIN_USER_TURNS = 3

export interface TitleSuggesterDeps {
  readonly store: TaskIndexStore
  readonly suggester: MetadataSuggester
}

export class TitleSuggester {
  private readonly store: TaskIndexStore
  private readonly suggester: MetadataSuggester

  private readonly candidates = new Map<TaskId, { fallbackTitle: string }>()
  private readonly userPrompts = new Map<string, string[]>()
  private readonly contexts = new Map<string, MetadataSuggestionContext>()
  private readonly attempted = new Set<TaskId>()
  private readonly inFlight = new Set<TaskId>()
  private readonly pendingTurnKeys = new Set<string>()

  constructor(deps: TitleSuggesterDeps) {
    this.store = deps.store
    this.suggester = deps.suggester
  }

  /**
   * Record a user turn. Trimmed prompts only — empty strings are
   * ignored. Seeds the fallback candidate the first time we see a turn
   * for a task that's still using its derived/placeholder title.
   */
  recordTurn(task: Task, tab: ChatTab, prompt: string | undefined, context: MetadataSuggestionContext): void {
    const trimmed = prompt?.trim()
    if (!trimmed) return
    const key = tabKey(task.id, tab.id)
    const prompts = this.userPrompts.get(key) ?? []
    prompts.push(trimmed)
    this.userPrompts.set(key, prompts)
    this.contexts.set(key, context)
    this.pendingTurnKeys.add(key)

    if (this.candidates.has(task.id)) return
    if (tab.sessionId) return
    const fallbackTitle = deriveTitleFromPrompt(trimmed)
    if (!fallbackTitle) return
    if (task.title === PLACEHOLDER_TASK_TITLE || task.title === fallbackTitle) {
      this.candidates.set(task.id, { fallbackTitle })
    }
  }

  /**
   * Called after the pump emits `done`. If this tab had a turn waiting
   * for completion, attempt the upgrade. Best-effort: a no-op if the
   * tab had no pending turn or the gate conditions aren't met.
   */
  async onTurnDone(taskId: TaskId, tabId: string): Promise<void> {
    const key = tabKey(taskId, tabId)
    if (!this.pendingTurnKeys.delete(key)) return
    await this.tryUpgrade(taskId, tabId)
  }

  /** User renamed the task manually — drop any candidate and stop trying. */
  noteUserRename(taskId: TaskId): void {
    this.candidates.delete(taskId)
    this.attempted.add(taskId)
  }

  clearTab(taskId: TaskId | string, tabId: string): void {
    const key = tabKey(taskId, tabId)
    this.userPrompts.delete(key)
    this.contexts.delete(key)
    this.pendingTurnKeys.delete(key)
  }

  clearTask(taskId: TaskId): void {
    this.candidates.delete(taskId)
    this.attempted.delete(taskId)
    this.inFlight.delete(taskId)
    for (const key of this.userPrompts.keys()) {
      if (tabKeyMatchesTask(key, taskId)) {
        this.userPrompts.delete(key)
        this.contexts.delete(key)
        this.pendingTurnKeys.delete(key)
      }
    }
  }

  private async tryUpgrade(taskId: TaskId, tabId: string): Promise<void> {
    if (this.attempted.has(taskId) || this.inFlight.has(taskId)) return
    const key = tabKey(taskId, tabId)
    const prompts = this.userPrompts.get(key) ?? []
    if (prompts.length < MIN_USER_TURNS) return
    const candidate = this.candidates.get(taskId)
    const context = this.contexts.get(key)
    const task = this.store.get(taskId)
    if (!candidate || !context || !task) return
    if (task.title !== candidate.fallbackTitle) return

    this.attempted.add(taskId)
    this.inFlight.add(taskId)
    try {
      const suggested = await this.suggester.suggestTitle(buildSuggestionPrompt(prompts), context)
      if (!suggested || suggested === candidate.fallbackTitle) return
      const fresh = this.store.get(taskId)
      if (!fresh) return
      if (fresh.title !== candidate.fallbackTitle) return
      await this.store.update(taskId, { title: suggested })
    } finally {
      this.inFlight.delete(taskId)
    }
  }
}

function buildSuggestionPrompt(prompts: readonly string[]): string {
  const lines = prompts.slice(0, MIN_USER_TURNS).map((prompt, i) => {
    const collapsed = prompt.replace(/\s+/g, " ").trim()
    return `${i + 1}. ${collapsed}`
  })
  return ["Conversation user messages:", ...lines].join("\n")
}
