/**
 * ChatSessionController (Solid hook form: `useChatSession`).
 *
 * Owns the per-ChatTab subscription / history / state-map ceremony
 * that previously lived as scattered effects inside `Chat.tsx`. Until
 * this extraction the lifecycle invariants were buried — every tab-
 * switch regression (KOB-21, the recent "all chats same content" /
 * "tab-switch reverts" bugs) hid in the timing between
 *
 *   1. the task-id changing,
 *   2. `tasksAcc()` reflecting the new task's `tabs` list,
 *   3. `syncTabSubs` adding subs for new tabs,
 *   4. `engine.readHistory()` resolving asynchronously,
 *   5. the chat's `activeTabId` mirror diverging from
 *      `task.activeTabId` after an external `setActiveTab`.
 *
 * Pulling all five into one module gives those invariants a single
 * name and a single test surface — `Chat.tsx` is left as a renderer
 * + interaction layer that consumes the controller's accessors.
 *
 * What the controller owns:
 *   - `statesByTab` / `draftsByTab` — per-ChatTab reducer state and
 *     composer draft text. Both move with the tab, not the task, and
 *     both live at module scope so they survive every Chat unmount
 *     (file-preview swap in the workspace, task switches, …) — wiping
 *     either map across remounts is what caused KOB-61 (queued
 *     prompts disappeared on every task switch). Per-tab pruning runs
 *     only when a tab is actually closed (`syncTabSubs`).
 *   - `activeTabId` — local mirror, sync'd in both directions with
 *     `Task.activeTabId`.
 *   - Subscriptions to `orchestrator.subscribeEvents` per ChatTab.
 *     Reconciled against the live `tabs` list on every reactive read.
 *   - History hydration on first attach to a tab that already has a
 *     `sessionId`.
 *
 * What it intentionally does NOT own:
 *   - The composer's send/queue/steer pipeline. Action handlers live
 *     in `Chat.tsx`; they call `patchActiveState` on the controller
 *     to mutate per-tab state.
 *   - Pane-level UI affordances (expanded tool index, scroll anchors,
 *     pending-prompt drain). Those are interaction concerns, not
 *     session state.
 *
 * See `CONTEXT.md` → "ChatSessionController" for the canonical
 * definition.
 */

import { type Accessor, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator.ts"
import { chatRunStateKey } from "../../../orchestrator/core.ts"
import type { OrchestratorEvent } from "../../../types/engine.ts"
import type { ChatTab, Task, TaskStatus } from "../../../types/task.ts"
import { type ChatState, applyEvent, createInitialState, pushSystemError, setMessagesFromHistory } from "./store"

export interface UseChatSessionOptions {
  /** Solid accessor for the active task id (undefined when none selected). */
  readonly taskId: Accessor<string | undefined>
  /** The orchestrator (local or remote). */
  readonly orchestrator: KobeOrchestrator
  /**
   * Hook fired after the controller has reset its per-tab state for
   * a fresh task. `Chat.tsx` uses this to clear its own non-session
   * UI bits (expandedToolIndex, fold cursor, scroll anchor) in the
   * same tick the session resets.
   */
  readonly onTaskReset?: () => void
}

export interface ChatSessionHandle {
  // ── Reactive readables ──────────────────────────────────────────
  /** Local mirror of the active ChatTab id; null when no task selected. */
  readonly activeTabId: Accessor<string | null>
  /** The active task's ChatTabs (mirrors `orchestrator.tasksSignal()`). */
  readonly tabs: Accessor<readonly ChatTab[]>
  /** The active task's record from `orchestrator.tasksSignal()`. */
  readonly task: Accessor<Task | undefined>
  /** The active task's status (from the same signal). */
  readonly taskStatus: Accessor<TaskStatus | undefined>
  /** ChatState for the currently-active ChatTab. */
  readonly activeState: Accessor<ChatState>
  /** Full per-ChatTab state map. Read for cross-tab effects (rare). */
  readonly statesByTab: Accessor<ReadonlyMap<string, ChatState>>
  /** Composer draft for the active ChatTab. */
  readonly draft: Accessor<string>

  // ── Imperative mutators ─────────────────────────────────────────
  /**
   * Update the active tab's ChatState in place. Composer / send /
   * interrupt action handlers call this to push system error rows,
   * record queue events, etc.
   */
  patchActiveState(updater: (s: ChatState) => ChatState): void
  /** Same as `patchActiveState` but targets a specific tab by id. */
  patchStateForTab(tabId: string, updater: (s: ChatState) => ChatState): void
  /** Set the active ChatTab id (optimistic local update). */
  setActiveTabIdLocal(id: string | null): void
  /** Write the active tab's composer draft. */
  setDraft(value: string): void
}

// Both per-tab maps live at module scope so they survive `<Chat>`
// unmount/remount AND task switches. The workspace center column
// toggles between Chat and Preview via `<Show>` (see app.tsx), and
// the task-switch branch below tears Chat's subs down per task — a
// hook-local signal would wipe either map in both cases, dropping
// queued prompts and in-progress composer text. Tab ids are globally
// unique, so a single shared map across the renderer is safe.
// Per-closed-tab cleanup still happens in `syncTabSubs` below
// (`unsub() + delete tabId from both maps`).
const [draftsByTab, setDraftsByTab] = createSignal<Map<string, string>>(new Map())
const [statesByTab, setStatesByTab] = createSignal<Map<string, ChatState>>(new Map())

export function useChatSession(opts: UseChatSessionOptions): ChatSessionHandle {
  const { orchestrator, onTaskReset } = opts

  const [activeTabId, setActiveTabIdLocal] = createSignal<string | null>(null)

  // Subscription registry. Lives outside the reactive system —
  // we update it imperatively from the lifecycle effect.
  let tabSubs: Map<string, () => void> = new Map()
  /** Track the task whose subs are currently in `tabSubs`. */
  let currentSubsTaskId: string | null = null

  const tasksAcc = orchestrator.tasksSignal()
  const task = createMemo<Task | undefined>(() => {
    const id = opts.taskId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)
  })
  const tabs = createMemo<readonly ChatTab[]>(() => task()?.tabs ?? [])
  const taskStatus = createMemo(() => task()?.status)

  const activeState = createMemo<ChatState>(() => {
    const id = activeTabId()
    if (!id) return createInitialState()
    return statesByTab().get(id) ?? createInitialState()
  })

  const draft = createMemo(() => {
    const id = activeTabId()
    if (!id) return ""
    return draftsByTab().get(id) ?? ""
  })

  function patchActiveState(updater: (s: ChatState) => ChatState): void {
    const id = activeTabId()
    if (!id) return
    setStatesByTab((prev) => {
      const next = new Map(prev)
      next.set(id, updater(prev.get(id) ?? createInitialState()))
      return next
    })
  }

  function patchStateForTab(tabId: string, updater: (s: ChatState) => ChatState): void {
    setStatesByTab((prev) => {
      const next = new Map(prev)
      next.set(tabId, updater(prev.get(tabId) ?? createInitialState()))
      return next
    })
  }

  function setDraft(value: string): void {
    const id = activeTabId()
    if (!id) return
    setDraftsByTab((prev) => {
      const cur = prev.get(id) ?? ""
      if (cur === value) return prev
      const next = new Map(prev)
      next.set(id, value)
      return next
    })
  }

  function teardownAllSubs(): void {
    for (const u of tabSubs.values()) u()
    tabSubs = new Map()
  }

  function replayPendingForTab(taskId: string, tabId: string): void {
    if (opts.taskId() !== taskId) return
    const key = chatRunStateKey(taskId, tabId)
    const pending = orchestrator.peekPendingInput(taskId)
    for (const entry of pending) {
      if (entry.tabKey !== key) continue
      patchStateForTab(tabId, (s) =>
        applyEvent(s, { type: "user_input.request", requestId: entry.requestId, payload: entry.payload }),
      )
    }
  }

  function hydrateHistoryForTab(
    taskId: string,
    tabId: string,
    sessionId: string,
    hydrateOpts: { showError?: boolean; preservePendingRows?: boolean } = {},
  ): Promise<void> {
    return orchestrator
      .readHistoryWithMetrics(sessionId)
      .then(({ messages, usageMetrics }) => {
        if (opts.taskId() !== taskId) return
        patchStateForTab(tabId, (s) =>
          hydrateOpts.preservePendingRows && hasPendingInputRow(s)
            ? s
            : setMessagesFromHistory(s, messages, usageMetrics),
        )
        // Pending input rows must land AFTER history hydration —
        // `setMessagesFromHistory` replaces `messages` wholesale, so
        // a synthesized approval / question row dispatched before
        // history loads would be wiped.
        replayPendingForTab(taskId, tabId)
      })
      .catch((err) => {
        if (hydrateOpts.showError !== false) {
          const msg = err instanceof Error ? err.message : String(err)
          patchStateForTab(tabId, (s) => pushSystemError(s, `history load failed: ${msg}`))
        }
        replayPendingForTab(taskId, tabId)
      })
  }

  function hasPendingInputRow(state: ChatState): boolean {
    return state.messages.some((message) => {
      if (message.kind === "approval") return message.status === "pending"
      if (message.kind === "question") return message.answers === null
      return false
    })
  }

  /**
   * Reconcile subscriptions against the current ChatTab list. Adds a
   * sub (and seeds state + hydrates history) for every new tab, drops
   * subs (and state + draft) for every closed tab. Idempotent — safe
   * to re-run on every reactive change.
   */
  function syncTabSubs(taskId: string, currentTabs: readonly ChatTab[]): void {
    const seen = new Set<string>()
    for (const tab of currentTabs) {
      seen.add(tab.id)
      if (tabSubs.has(tab.id)) continue
      setStatesByTab((prev) => {
        if (prev.has(tab.id)) return prev
        const next = new Map(prev)
        next.set(tab.id, createInitialState())
        return next
      })
      const tabId = tab.id
      const unsub = orchestrator.subscribeEvents(
        taskId,
        (ev: OrchestratorEvent) => {
          patchStateForTab(tabId, (s) => applyEvent(s, ev))
        },
        tabId,
      )
      tabSubs.set(tabId, unsub)
      // Rehydrate per-tab live state from the orchestrator's snapshot.
      // The daemon's `hello` handshake seeds the orchestrator's run-state
      // map and pending-input broker on reconnect, but per-tab ChatState
      // is built locally — without this seeding step a TUI that reattaches
      // mid-stream sees `isStreaming: false` (composer unlocked, spinner
      // missing) and an empty messages list with no approval / question
      // row, until the next live event happens to land.
      const tabKey = chatRunStateKey(taskId, tabId)
      const runState = orchestrator.chatRunStateSignal()().get(tabKey)
      // Sync isStreaming in BOTH directions on re-attach. Now that
      // statesByTab is module-scoped and survives Chat remounts +
      // task switches, a turn that finished while the user was on
      // another task / inside the file preview would otherwise leave
      // `isStreaming: true` from before the switch — locking the
      // composer until the user manually submitted something. The
      // orchestrator's chat-run-state map is authoritative; mirror it.
      patchStateForTab(tabId, (s) => ({ ...s, isStreaming: runState === "running" }))
      if (tab.sessionId) {
        hydrateHistoryForTab(taskId, tabId, tab.sessionId, {
          preservePendingRows: tab.source === "background_agent",
        })
      } else {
        replayPendingForTab(taskId, tabId)
      }
    }
    for (const [tabId, unsub] of tabSubs) {
      if (seen.has(tabId)) continue
      unsub()
      tabSubs.delete(tabId)
      setStatesByTab((prev) => {
        if (!prev.has(tabId)) return prev
        const next = new Map(prev)
        next.delete(tabId)
        return next
      })
      setDraftsByTab((prev) => {
        if (!prev.has(tabId)) return prev
        const next = new Map(prev)
        next.delete(tabId)
        return next
      })
    }
  }

  // Task + tab reconciler. ONE effect handles both:
  //   - taskId change: tear down prior subs/state, reset local UI.
  //   - tasksAcc change (post-createTask, post-createTab/closeTab):
  //     reactively pick up the new task / new tabs.
  // Earlier this was split across three effects, which raced when the
  // newly-created task wasn't yet in `tasksAcc()` at the moment
  // `setSelectedId` fired (the task-switch effect bailed via
  // `getTask() === undefined` and the tabs-change effect refused to
  // initialize because `currentSubsTaskId !== taskId`). The merged
  // effect simply waits for the task to land in the signal — it
  // re-runs on the next tasksAcc tick and seeds correctly.
  createEffect(() => {
    const id = opts.taskId()
    if (!id) {
      if (currentSubsTaskId !== null) {
        // Tear down event subs only. statesByTab + draftsByTab are
        // module-scoped now and must survive every transition — wiping
        // them here would erase queued prompts + composer drafts the
        // moment the user lands on a no-task state (rare but possible).
        teardownAllSubs()
        onTaskReset?.()
      }
      setActiveTabIdLocal(null)
      currentSubsTaskId = null
      return
    }
    // Reactive read — re-runs when the task lands or its tabs change.
    const live = tasksAcc().find((t) => t.id === id)
    if (!live) {
      // Task not yet in signal (race with createTask). The effect
      // re-runs when tasksAcc updates; until then, leave subs alone.
      return
    }
    if (currentSubsTaskId !== id) {
      // Switched tasks (or first time we see this task). Tear the
      // outgoing task's event subs down, but DO NOT wipe statesByTab /
      // draftsByTab — both are module-scoped per-tab maps that have to
      // survive a task round-trip so queued prompts and composer drafts
      // come back when the user returns to the tab (KOB-61). syncTabSubs
      // below's `if (prev.has(tab.id)) return prev` guard preserves
      // returning tabs' state instead of clobbering it with a fresh
      // createInitialState().
      teardownAllSubs()
      currentSubsTaskId = id
      setActiveTabIdLocal(live.activeTabId)
      onTaskReset?.()
    } else {
      // Same task, tabs / activeTabId may have changed. Mirror the
      // persisted activeTabId whenever it diverges from local — this is
      // what makes external tab-switches (e.g. clicking a chat-tab chip
      // in the workspace strip, which calls `orchestrator.setActiveTab`
      // directly without touching this hook) actually drive the chat
      // view. Internal switches via the consumer's tab-picker also
      // call `setActiveTab`, but they set `activeTabIdLocal` first so
      // this branch sees `local === task.activeTabId` and no-ops.
      // Earlier the guard was "only sync when local is null or pointing
      // at a closed tab" — that ignored legitimate external switches
      // and produced "switched the chip but chat content stayed on the
      // old tab" (KOB-21).
      const local = activeTabId()
      if (local !== live.activeTabId) {
        setActiveTabIdLocal(live.activeTabId)
      }
    }
    syncTabSubs(id, live.tabs)
  })

  createEffect(() => {
    const live = task()
    const tabId = activeTabId()
    if (!live || !tabId) return
    const tab = live.tabs.find((candidate) => candidate.id === tabId)
    if (!tab?.sessionId) return
    if (tab.source !== "background_agent") return
    const sessionId = tab.sessionId
    const taskId = live.id
    let refreshing = false
    const interval = setInterval(() => {
      const runState = orchestrator.chatRunStateSignal()().get(chatRunStateKey(taskId, tabId))
      if (runState === "running" || runState === "awaiting_input" || refreshing) return
      refreshing = true
      hydrateHistoryForTab(taskId, tabId, sessionId, { showError: false, preservePendingRows: true }).finally(() => {
        refreshing = false
      })
    }, 1500)
    onCleanup(() => clearInterval(interval))
  })

  onCleanup(() => {
    // Tear subs down only. Both statesByTab and draftsByTab are at
    // module scope and must outlive every Chat unmount — opening the
    // file preview (workspace `<Show>` flips), task switches, and any
    // other transient remount would otherwise wipe queued prompts and
    // composer drafts. Per-tab pruning happens in `syncTabSubs` when a
    // tab is closed; full process exit drops module state naturally.
    teardownAllSubs()
  })

  return {
    activeTabId,
    tabs,
    task,
    taskStatus,
    activeState,
    statesByTab,
    draft,
    patchActiveState,
    patchStateForTab,
    setActiveTabIdLocal,
    setDraft,
  }
}
