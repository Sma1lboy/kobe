/**
 * Chat pane — shell.
 *
 * After Wave 4's split, this file owns:
 *   - State: `statesByTab` (Map<tabId, ChatState>), `activeTabId`,
 *     `draft`, `expandedToolIndex`.
 *   - Effects: task-switch resubscribe + history reload, tab list
 *     reconciler, pending-prompt auto-submit, unmount tidy-up.
 *   - Submit pipeline: `send()` (used by both onSubmit + auto-prompt).
 *   - Tab lifecycle: `newTab`, `closeActiveTab`, `selectTabByIndex`,
 *     `cycleTab`, plus pane-scoped keybindings (ctrl+t / ctrl+w /
 *     ctrl+tab / ctrl+1..9 when multi-tab).
 *   - Layout: header, tab bar, scrollbox container, MessageList, Composer.
 *
 * State model — see `./store.ts` top-of-file. Single chronological
 * `messages: ChatRow[]` PER TAB; user submits append; assistant deltas
 * append or coalesce; tool starts/results pair by name. Pure-data,
 * vitest-friendly.
 *
 * Multi-tab notes:
 *   - Each tab subscribes independently to its (taskId, tabId) bus key.
 *     Switching tabs swaps which tab's state we render — it does NOT
 *     unsubscribe the inactive tabs, so events keep flowing in the
 *     background and `done` lands even when the user isn't looking.
 *   - Closing the active tab is delegated to the orchestrator, which
 *     returns the next active tab id; we mirror that locally.
 *   - ctrl+1..9 numeric jumps only register when there's >1 tab so
 *     we don't shadow app.tsx's global "ctrl+1..4 = pane focus" muscle
 *     memory in the common single-tab case.
 *
 * Load-bearing invariants (must NOT regress):
 *   - The "thinking" indicator must appear within one render frame of
 *     submit. The G3 behavior test asserts this.
 *   - Streaming text accumulates by appending each `assistant.delta`
 *     to the rolling render. We do NOT mutate.
 *   - Task switch tears down the prior subscriptions before subscribing
 *     to the new ones.
 */

import { type ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { type Accessor, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import type { Orchestrator } from "../../../orchestrator/core.ts"
import type { OrchestratorEvent } from "../../../types/engine.ts"
import type { ChatTab } from "../../../types/task.ts"
import { bindByIds } from "../../context/keybindings"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { useDialog } from "../../ui/dialog"
import { Composer, type ComposerSlashEntry } from "./Composer"
import { MessageList } from "./MessageList"
import { ModelPicker } from "./composer/ModelPicker"
import { BUILTIN_CLAUDE_SLASHES, type BuiltinSlash } from "./composer/builtin-slashes"
import { modelLabelFor } from "./composer/models"
import { loadUserSlashes } from "./composer/user-slashes"
import {
  type ChatState,
  applyEvent,
  createInitialState,
  pushSystemError,
  pushUser,
  setMessagesFromHistory,
} from "./store"

export type ChatProps = {
  orchestrator: Orchestrator
  /**
   * Solid accessor for the currently selected task id. We accept an
   * accessor (not a static prop) so task switches re-run effects
   * without React-style rerender ceremony.
   */
  taskId: Accessor<string | undefined>
  /** Active task title for the header. */
  title?: Accessor<string | undefined>
  /**
   * Optional pending prompt to auto-submit on first selection of the
   * matching task. Used by the new-task flow: the user types the
   * first prompt in the dialog, and we submit it on their behalf the
   * moment the task lands in the index. Accessor returns undefined
   * when there's nothing to submit.
   */
  pendingPrompt?: Accessor<string | undefined>
  /**
   * Called once we've consumed `pendingPrompt`. The parent uses this
   * to clear its pending-prompt signal so a re-subscribe (e.g. the
   * task gets re-selected after a switch) doesn't re-submit.
   */
  onPendingPromptConsumed?: () => void
  /**
   * Whether the chat pane currently owns the keyboard focus. Gates
   * the pane-local tab keybindings (ctrl+t, ctrl+w, ctrl+1..9,
   * ctrl+tab) so they don't fire while the sidebar / files / terminal
   * own focus.
   */
  focused?: Accessor<boolean>
}

export function Chat(props: ChatProps) {
  const { theme } = useTheme()
  const dialog = useDialog()

  // Slash-command list. Two sources, merged on every task switch:
  //
  //   1. Built-ins — from refs/claude-code/src/commands/, baked into
  //      ./composer/builtin-slashes.ts via scripts/extract-claude-code-commands.mjs.
  //      Filtered to commands that actually run in `claude -p`.
  //   2. User-defined — `<worktree>/.claude/{commands,skills}/` plus
  //      `~/.claude/{commands,skills}/`, scanned at runtime by
  //      loadUserSlashes() (ported from vibe-kanban's
  //      slash_commands.rs). Project entries shadow global ones; user
  //      entries shadow built-ins on name collision.
  //
  // We don't add kobe-specific slashes here — keyboard shortcuts
  // (n / d / a) own the orchestrator verbs so the slash menu stays
  // the pure claude-code surface.
  const [userSlashes, setUserSlashes] = createSignal<readonly BuiltinSlash[]>([])
  createEffect(
    on(
      () => props.taskId(),
      (taskId) => {
        const task = taskId ? props.orchestrator.getTask(taskId) : undefined
        const wt = task?.worktreePath || undefined
        loadUserSlashes(wt)
          .then(setUserSlashes)
          .catch(() => setUserSlashes([]))
      },
    ),
  )

  const slashes = createMemo<readonly ComposerSlashEntry[]>(() => {
    // User overrides built-in on name collision. We track origin
    // alongside the entry so the dropdown can surface a "user" tag —
    // a name collision where the user shadowed a built-in counts as
    // a user entry (their definition is what runs).
    type Tagged = { entry: BuiltinSlash; source: "builtin" | "user" }
    const map = new Map<string, Tagged>()
    for (const e of BUILTIN_CLAUDE_SLASHES) map.set(e.name, { entry: e, source: "builtin" })
    for (const e of userSlashes()) map.set(e.name, { entry: e, source: "user" })
    return [...map.values()]
      .sort((a, b) => a.entry.name.localeCompare(b.entry.name))
      .map(({ entry, source }) => ({
        display: `/${entry.name}`,
        description: entry.description || undefined,
        aliases: entry.aliases?.map((a) => `/${a}`),
        source,
        onSelect: () => {
          void send(`/${entry.name}`)
        },
      }))
  })

  // Per-tab chat state. Map<tabId, ChatState>. We update via copy-on-
  // write helpers so Solid notices.
  const [statesByTab, setStatesByTab] = createSignal<Map<string, ChatState>>(new Map())
  const [activeTabId, setActiveTabIdLocal] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal("")
  const [expandedToolIndex, setExpandedToolIndex] = createSignal<number | null>(null)

  // Reactive view of the active task's tabs, pulled from the
  // orchestrator's signal so the tab bar redraws on createTab/closeTab
  // without manual refresh.
  const tasksAcc = props.orchestrator.tasksSignal()
  const tabs = createMemo<readonly ChatTab[]>(() => {
    const id = props.taskId()
    if (!id) return []
    const t = tasksAcc().find((x) => x.id === id)
    return t?.tabs ?? []
  })

  const activeState = createMemo<ChatState>(() => {
    const id = activeTabId()
    if (!id) return createInitialState()
    return statesByTab().get(id) ?? createInitialState()
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

  // Subscriptions per tab id. Lives outside Solid's reactive system —
  // it's a registry the effects mutate, never a value Solid renders.
  let tabSubs: Map<string, () => void> = new Map()
  /** Track the task whose subs are currently in `tabSubs`. */
  let currentSubsTaskId: string | null = null

  /**
   * Synchronise tab subscriptions to `currentTabs`. Adds subs (and
   * seeds state + history reload) for new tabs, drops subs (and state)
   * for closed tabs.
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
      const u = props.orchestrator.subscribeEvents(
        taskId,
        (ev: OrchestratorEvent) => {
          patchStateForTab(tabId, (s) => applyEvent(s, ev))
        },
        tabId,
      )
      tabSubs.set(tabId, u)
      if (tab.sessionId) {
        const sid = tab.sessionId
        props.orchestrator
          .readHistory(sid)
          .then((past) => {
            if (props.taskId() !== taskId) return
            patchStateForTab(tabId, (s) => setMessagesFromHistory(s, past))
            // History just landed on the active tab: snap to bottom.
            if (activeTabId() === tabId) queueMicrotask(scrollToBottom)
          })
          .catch((err) => {
            patchStateForTab(tabId, (s) => pushSystemError(s, `history load failed: ${stringifyErr(err)}`))
          })
      }
    }
    for (const [tabId, u] of tabSubs) {
      if (seen.has(tabId)) continue
      u()
      tabSubs.delete(tabId)
      setStatesByTab((prev) => {
        if (!prev.has(tabId)) return prev
        const next = new Map(prev)
        next.delete(tabId)
        return next
      })
    }
  }

  function teardownAllSubs(): void {
    for (const u of tabSubs.values()) u()
    tabSubs = new Map()
  }

  // Reactive view of the active task's status. `canceled` blocks the
  // composer because the orchestrator rejects `canceled → in_progress`.
  const taskStatus = createMemo(() => {
    const id = props.taskId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)?.status
  })
  const isCanceled = () => taskStatus() === "canceled"

  // True when the active tab's message list ends with an unresolved
  // approval/question row. While a user-input request is pending we
  // lock the composer:
  //   - The subprocess was killed (orchestrator.pumpEvents stops it on
  //     tool.start so the model can't yap past the picker).
  //   - The picker IS the only valid next action; typing a freeform
  //     prompt would resume the session ahead of the picker's answer
  //     and the model would see "[user said something else]" instead of
  //     "[plan approved] / [question answered]".
  // Scans from the end so a long history doesn't cost more than O(few)
  // — the picker is always near the bottom. Stops at the first user/
  // assistant row because anything newer than the picker means the
  // conversation moved on (i.e. the picker was already resolved).
  const hasPendingInput = createMemo(() => {
    const msgs = activeState().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (!m) continue
      if (m.kind === "approval") return m.status === "pending"
      if (m.kind === "question") return m.answers === null
      if (m.kind === "user" || m.kind === "assistant") return false
    }
    return false
  })

  // Per-task permission mode (shift+tab cycle in the composer).
  const permissionMode = createMemo(() => {
    const id = props.taskId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)?.permissionMode
  })

  function cyclePermissionMode(): void {
    const id = props.taskId()
    if (!id) return
    const current = permissionMode() ?? "default"
    const next = current === "default" ? "acceptEdits" : current === "acceptEdits" ? "plan" : "default"
    void props.orchestrator.setPermissionMode(id, next).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[kobe] setPermissionMode failed:", err)
    })
  }

  // Per-task model id + picker.
  const modelId = createMemo(() => {
    const id = props.taskId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)?.model
  })
  const modelLabel = createMemo(() => modelLabelFor(modelId()))

  async function chooseModel(): Promise<void> {
    const id = props.taskId()
    if (!id) return
    const result = await ModelPicker.show(dialog, modelId())
    if (result === undefined) return
    const next = result ?? undefined
    await props.orchestrator.setModel(id, next).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[kobe] setModel failed:", err)
    })
  }

  // Task + tab reconciler. ONE effect handles both:
  //   - taskId change: tear down prior subs/state, reset local UI.
  //   - tasksAcc change (post-createTask, post-createTab/closeTab):
  //     reactively pick up the new task / new tabs.
  //
  // Earlier this was split across three effects, which raced when the
  // newly-created task wasn't yet in `tasksAcc()` at the moment
  // `setSelectedId` fired (the task-switch effect bailed via
  // `getTask() === undefined` and the tabs-change effect refused to
  // initialize because `currentSubsTaskId !== taskId`). The merged
  // effect simply waits for the task to land in the signal — it
  // re-runs on the next tasksAcc tick and seeds correctly.
  createEffect(() => {
    const taskId = props.taskId()
    if (!taskId) {
      if (currentSubsTaskId !== null) {
        teardownAllSubs()
        setStatesByTab(new Map())
        setDraft("")
        setExpandedToolIndex(null)
      }
      setActiveTabIdLocal(null)
      currentSubsTaskId = null
      return
    }
    // Reactive read — re-runs when the task lands or its tabs change.
    const task = tasksAcc().find((t) => t.id === taskId)
    if (!task) {
      // Task not yet in signal (race with createTask). The effect
      // re-runs when tasksAcc updates; until then, leave subs alone.
      return
    }
    if (currentSubsTaskId !== taskId) {
      // Switched tasks (or first time we see this task): reset.
      teardownAllSubs()
      setStatesByTab(new Map())
      setDraft("")
      setExpandedToolIndex(null)
      currentSubsTaskId = taskId
      setActiveTabIdLocal(task.activeTabId)
      queueMicrotask(scrollToBottom)
    } else {
      // Same task, tabs may have changed — mirror persisted
      // activeTabId only when local is null or pointing at a closed
      // tab (don't clobber the user's local switch).
      const local = activeTabId()
      if (!local || !task.tabs.some((t) => t.id === local)) {
        setActiveTabIdLocal(task.activeTabId)
      }
    }
    syncTabSubs(taskId, task.tabs)
  })

  // Scroll anchor — used to force the message list back to the bottom
  // when the chat (re)opens, the user switches tasks, or history lands
  // asynchronously. opentui's stickyScroll keeps follow-mode working
  // for incremental growth but doesn't re-anchor across these paths.
  let scrollRef: ScrollBoxRenderable | undefined
  function scrollToBottom(): void {
    const r = scrollRef
    if (!r) return
    r.scrollTo({ x: 0, y: r.scrollHeight })
  }

  onMount(() => {
    queueMicrotask(scrollToBottom)
  })

  // After every render that could grow the active tab's list, snap to
  // the bottom — only while the user is still in follow mode.
  createEffect(() => {
    void activeState().messages.length
    queueMicrotask(() => {
      const r = scrollRef
      if (!r) return
      const distanceFromBottom = r.scrollHeight - r.scrollTop - r.height
      if (distanceFromBottom <= 2) r.scrollTo({ x: 0, y: r.scrollHeight })
    })
  })

  // Snap to bottom on tab switch too — the user expects to see the
  // most recent message, not whatever the prior view's scroll was.
  createEffect(() => {
    void activeTabId()
    queueMicrotask(scrollToBottom)
  })

  // Pending-prompt watcher — see top-of-file lifecycle notes.
  createEffect(() => {
    const pp = props.pendingPrompt?.()
    const taskId = props.taskId()
    if (!pp || !taskId) return
    if (pp.length === 0) return
    if (activeState().isStreaming) return
    props.onPendingPromptConsumed?.()
    queueMicrotask(() => {
      void send(pp)
    })
  })

  onCleanup(() => {
    teardownAllSubs()
    setStatesByTab(new Map())
  })

  /**
   * Submit a prompt to the active tab. Pulls the active taskId + tabId
   * from accessors so this is safe to call from both the auto-pending-
   * prompt path and the composer's onSubmit handler.
   */
  async function send(promptText?: string): Promise<void> {
    const text = (promptText ?? draft()).trim()
    const taskId = props.taskId()
    const tabId = activeTabId()
    if (!text || !taskId || !tabId) return
    if (isCanceled()) return
    if (activeState().isStreaming) return
    setDraft("")
    patchActiveState((s) => pushUser(s, text))
    try {
      await props.orchestrator.runTask(taskId, text, tabId)
    } catch (err) {
      patchActiveState((s) => pushSystemError(s, `runTask failed: ${stringifyErr(err)}`))
    }
  }

  /** Create a new tab and switch focus to it. Wired from `ctrl+t`. */
  async function newTab(): Promise<void> {
    const taskId = props.taskId()
    if (!taskId) return
    try {
      const tab = await props.orchestrator.createTab(taskId)
      setActiveTabIdLocal(tab.id)
      setDraft("")
      setExpandedToolIndex(null)
      void props.orchestrator.setActiveTab(taskId, tab.id)
    } catch (err) {
      patchActiveState((s) => pushSystemError(s, `createTab failed: ${stringifyErr(err)}`))
    }
  }

  /** Close the active tab (refuses to close the last one). */
  async function closeActiveTab(): Promise<void> {
    const taskId = props.taskId()
    const tabId = activeTabId()
    if (!taskId || !tabId) return
    if (tabs().length <= 1) return
    try {
      const nextActive = await props.orchestrator.closeTab(taskId, tabId)
      if (nextActive) {
        setActiveTabIdLocal(nextActive)
        setDraft("")
        setExpandedToolIndex(null)
      }
    } catch (err) {
      patchActiveState((s) => pushSystemError(s, `closeTab failed: ${stringifyErr(err)}`))
    }
  }

  /** Switch to the tab at the given 0-indexed position. Out-of-range = no-op. */
  function selectTabByIndex(idx: number): void {
    const t = tabs()[idx]
    if (!t) return
    setActiveTabIdLocal(t.id)
    setDraft("")
    setExpandedToolIndex(null)
    const taskId = props.taskId()
    if (taskId) void props.orchestrator.setActiveTab(taskId, t.id)
  }

  function cycleTab(delta: 1 | -1): void {
    const list = tabs()
    if (list.length <= 1) return
    const cur = activeTabId()
    const idx = cur ? list.findIndex((t) => t.id === cur) : 0
    const next = (idx + delta + list.length) % list.length
    selectTabByIndex(next)
  }

  // Pane-scoped keybindings: only fire when the chat pane is focused.
  // chat.tab.pick (ctrl+1..9) is the table's single chat-tab-pick id; we
  // gate it on `tabs().length > 1` so we don't shadow app.tsx's global
  // "ctrl+1..4 = pane focus" muscle memory when there's only one tab.
  useBindings(() => {
    const tabsOpen = tabs().length
    return {
      enabled: props.focused?.() === true,
      bindings: bindByIds({
        "chat.tab.new": () => void newTab(),
        "chat.tab.close": () => void closeActiveTab(),
        "chat.tab.cycle-next": () => cycleTab(1),
        "chat.tab.cycle-prev": () => cycleTab(-1),
        "chat.tab.pick": (evt) => {
          if (tabsOpen <= 1) return
          const n = Number.parseInt(evt.name ?? "", 10)
          if (n >= 1 && n <= Math.min(9, tabsOpen)) selectTabByIndex(n - 1)
        },
      }),
    }
  })

  // Render-derived: index of the trailing assistant row (anchor for the
  // streaming cursor) and trailing tool row (anchor for "enter expands").
  const lastAssistantIdx = createMemo(() => {
    const msgs = activeState().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const r = msgs[i]
      if (r && r.kind === "assistant") return i
    }
    return -1
  })

  // Spinner shows whenever a turn is in flight — independent of how
  // many assistant rows already exist. Earlier this was gated on
  // `lastAssistantIdx() === -1`; that gate misfired on every turn
  // after the first because `lastAssistantIdx` scans the whole
  // transcript. Claude Code itself keeps the spinner up alongside the
  // streamed text (refs/claude-code/src/components/Spinner/SpinnerAnimationRow.tsx).
  const showThinking = createMemo(() => activeState().isStreaming)

  // Wall-clock turn start. Latched when isStreaming flips false→true,
  // cleared on done/error/task/tab-switch. Feeds Loading's elapsed timer.
  const [turnStartedAt, setTurnStartedAt] = createSignal<number | undefined>(undefined)
  createEffect(() => {
    if (activeState().isStreaming) {
      setTurnStartedAt((cur) => cur ?? Date.now())
    } else {
      setTurnStartedAt(undefined)
    }
  })

  // Chars of assistant text in the *current* turn — sum after the most
  // recent user row. Drives Loading's token estimate (chars/4, mirroring
  // Claude Code's `SpinnerAnimationRow` `leaderTokens` heuristic).
  const currentTurnChars = createMemo(() => {
    const msgs = activeState().messages
    let lastUserIdx = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.kind === "user") {
        lastUserIdx = i
        break
      }
    }
    let chars = 0
    for (let i = lastUserIdx + 1; i < msgs.length; i++) {
      const r = msgs[i]
      if (r && r.kind === "assistant") chars += r.text.length
    }
    return chars
  })

  const lastToolIndex = createMemo(() => {
    const msgs = activeState().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const r = msgs[i]
      if (r && r.kind === "tool") return i
    }
    return null
  })

  function toggleExpandLastTool(): void {
    const idx = lastToolIndex()
    if (idx == null) return
    setExpandedToolIndex((cur) => (cur === idx ? null : idx))
  }

  function toggleExpand(rowIndex: number): void {
    setExpandedToolIndex((cur) => (cur === rowIndex ? null : rowIndex))
  }

  function handleComposerSubmit(trimmed: string): void {
    if (trimmed.length === 0) {
      if (lastToolIndex() !== null) toggleExpandLastTool()
      return
    }
    void send()
  }

  return (
    <box flexGrow={1} flexDirection="column" paddingLeft={1} paddingRight={1}>
      {/* Tab bar lives in the workspace's CenterTabStrip — see app.tsx.
          Chat tabs are rendered alongside open files there so we don't
          double up tab UI. ctrl+t / ctrl+w / ctrl+1..9 / ctrl+tab keys
          are still handled here. */}

      {/* Empty state for "no task selected". */}
      <Show when={!props.taskId()}>
        <box flexGrow={1} alignItems="center" justifyContent="center">
          <text fg={theme.textMuted}>Select a task or press n to create one.</text>
        </box>
      </Show>

      {/* Message list. */}
      <Show when={props.taskId()}>
        <scrollbox
          ref={(r: ScrollBoxRenderable) => {
            scrollRef = r
          }}
          flexGrow={1}
          stickyScroll={true}
          stickyStart="bottom"
          verticalScrollbarOptions={{
            trackOptions: { backgroundColor: theme.background, foregroundColor: theme.borderActive },
          }}
        >
          <box paddingRight={1} gap={0}>
            <MessageList
              messages={activeState().messages}
              isStreaming={activeState().isStreaming}
              lastAssistantIdx={lastAssistantIdx()}
              expandedToolIndex={expandedToolIndex()}
              onToggleTool={toggleExpand}
              showThinking={showThinking()}
              thinkingStartedAt={turnStartedAt()}
              thinkingResponseChars={currentTurnChars()}
              error={activeState().error}
              onApprove={(requestId, approve) => {
                const taskId = props.taskId()
                if (!taskId) return
                props.orchestrator
                  .respondToInput(taskId, requestId, { kind: "approve_plan", approve })
                  .catch((err: unknown) => {
                    patchActiveState((s) => pushSystemError(s, `respondToInput failed: ${stringifyErr(err)}`))
                  })
              }}
              onAnswer={(requestId, answers) => {
                const taskId = props.taskId()
                if (!taskId) return
                props.orchestrator
                  .respondToInput(taskId, requestId, { kind: "ask_question", answers })
                  .catch((err: unknown) => {
                    patchActiveState((s) => pushSystemError(s, `respondToInput failed: ${stringifyErr(err)}`))
                  })
              }}
            />
          </box>
        </scrollbox>
      </Show>

      {/* Composer. */}
      <Composer
        draft={draft()}
        onDraftChange={setDraft}
        isStreaming={activeState().isStreaming}
        hasTask={props.taskId() !== undefined && !isCanceled() && !hasPendingInput()}
        noTaskMessage={
          isCanceled()
            ? "(task canceled — pick another or press ctrl+n to create)"
            : hasPendingInput()
              ? "(answer the prompt above to continue)"
              : undefined
        }
        onSubmit={handleComposerSubmit}
        focused={props.focused}
        // Per-tab history scope — prompt history shouldn't bleed across tabs.
        historyKey={activeTabId() ?? props.taskId()}
        slashes={slashes}
        permissionMode={permissionMode}
        onCyclePermissionMode={cyclePermissionMode}
        modelLabel={modelLabel}
        onChooseModel={() => void chooseModel()}
      />
    </box>
  )
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return err.message
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
