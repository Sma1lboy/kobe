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
import { type Accessor, For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator.ts"
import type { OrchestratorEvent, PermissionMode } from "../../../types/engine.ts"
import type { ChatTab } from "../../../types/task.ts"
import { ResumeDialog } from "../../component/resume-dialog"
import { bindByIds } from "../../context/keybindings"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { useDialog } from "../../ui/dialog"
import { Composer, type ComposerSlashEntry } from "./Composer"
import { Loading } from "./Loading"
import { MessageList } from "./MessageList"
import { ModelPicker } from "./composer/ModelPicker"
import { BUILTIN_CLAUDE_SLASHES, type BuiltinSlash } from "./composer/builtin-slashes"
import { modelLabelFor, resolveDefaultModelId } from "./composer/models"
import { loadUserSlashes } from "./composer/user-slashes"
import { formatContextUsageCompact } from "./context-meter"
import {
  type ChatRow,
  type ChatState,
  createInitialState,
  dequeueFirst,
  enqueuePrompt,
  pushSystemError,
  queueIsFull,
  removeFromQueue,
} from "./store"
import { useChatSession } from "./use-chat-session"

export type ChatProps = {
  orchestrator: KobeOrchestrator
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
  /**
   * Live context-usage label for the WORKSPACE pane header (e.g. `12% · 24k/200k`).
   * Parent passes null to clear.
   */
  onContextMeter?: (label: string | null) => void
  /**
   * Rename-tab callback. Fires on `ctrl+r` with the active chat tab
   * id; the parent (app.tsx) opens an input dialog and calls
   * `orchestrator.setTabTitle`. Mirrors the sidebar's rename flow —
   * Chat stays stateless of the dialog.
   */
  onRenameTabRequest?: (tabId: string) => void
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
    const claudeEntries: ComposerSlashEntry[] = [...map.values()].map(({ entry, source }) => ({
      display: `/${entry.name}`,
      description: entry.description || undefined,
      aliases: entry.aliases?.map((a) => `/${a}`),
      source,
      onSelect: () => {
        void send(`/${entry.name}`)
      },
    }))
    // kobe-side slashes are short-circuited in `send()` rather than
    // forwarded to the engine. Listed here purely so the dropdown
    // surfaces them as a discoverable command.
    const kobeEntries: ComposerSlashEntry[] = [
      {
        display: "/clear",
        description: "Reset this chat tab (drops session, keeps history on disk)",
        source: "builtin",
        onSelect: () => {
          void send("/clear")
        },
      },
    ]
    return [...kobeEntries, ...claudeEntries].sort((a, b) => a.display.localeCompare(b.display))
  })

  // Per-ChatTab state + subscription lifecycle live in
  // `useChatSession` — see `./use-chat-session.ts` (and CONTEXT.md →
  // ChatSessionController) for the seam rationale. Chat.tsx
  // consumes the resulting accessors + mutators; everything tab-
  // scoped reads / writes through the controller.
  const session = useChatSession({
    taskId: () => props.taskId(),
    orchestrator: props.orchestrator,
    onTaskReset: () => {
      setExpandedToolIndex(null)
      setExpandedFoldStartIndex(null)
    },
  })
  const activeTabId = session.activeTabId
  const setActiveTabIdLocal = session.setActiveTabIdLocal
  const statesByTab = session.statesByTab
  const tabs = session.tabs
  const activeState = session.activeState
  const draft = session.draft
  const setDraft = session.setDraft
  const patchActiveState = session.patchActiveState
  const patchStateForTab = session.patchStateForTab

  const [expandedToolIndex, setExpandedToolIndex] = createSignal<number | null>(null)
  const [expandedFoldStartIndex, setExpandedFoldStartIndex] = createSignal<number | null>(null)

  const tasksAcc = props.orchestrator.tasksSignal()

  const contextMeterLabel = createMemo(() => {
    const tid = props.taskId()
    const tabId = activeTabId()
    if (!tid || !tabId) return null
    const st = statesByTab().get(tabId)
    const u = st?.lastUsage
    if (!u) return null
    const task = props.orchestrator.getTask(tid)
    const modelId = task?.model ?? resolveDefaultModelId()
    return formatContextUsageCompact(u, modelId)
  })

  createEffect(
    on(contextMeterLabel, (label) => {
      props.onContextMeter?.(label ?? null)
    }),
  )

  // Reactive view of the active task's status. `canceled` blocks the
  // composer because the orchestrator rejects `canceled → in_progress`.
  const taskStatus = createMemo(() => {
    const id = props.taskId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)?.status
  })
  const isCanceled = () => taskStatus() === "canceled"

  // Look up the tail of the active tab for an unresolved user-input
  // row. Scans from the end (the picker is always near the bottom) and
  // stops at the first user/assistant row — anything newer than the
  // picker means the conversation moved on (i.e. the picker was
  // already resolved). Returned shape is the row itself so callers
  // can read the requestId / questions list for routing.
  function findPending(): Extract<ChatRow, { kind: "approval" | "question" }> | null {
    const msgs = activeState().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (!m) continue
      if (m.kind === "approval") return m.status === "pending" ? m : null
      if (m.kind === "question") return m.answers === null ? m : null
      if (m.kind === "user" || m.kind === "assistant") return null
    }
    return null
  }

  // Pending approval lock — the subprocess was killed on tool.start
  // and the only valid next action is Approve/Reject. Free-text would
  // resume the session ahead of the picker's answer and the model
  // would see "[user said something else]" instead of "[plan
  // approved]". Approval stays locked.
  const pendingApproval = createMemo(() => {
    const p = findPending()
    return p?.kind === "approval" ? p : null
  })
  // Pending question — picker is up but the user can still type a
  // free-text answer via the composer (per the AskUserQuestion tool's
  // "always allow custom text" contract). Composer-submit reroutes
  // to respondToInput; see handleComposerSubmit.
  const pendingQuestion = createMemo(() => {
    const p = findPending()
    return p?.kind === "question" ? p : null
  })
  // Backwards-compat alias for legacy call sites that just want "any
  // pending input"; new code should prefer the split memos.
  const hasPendingInput = createMemo(() => pendingApproval() !== null || pendingQuestion() !== null)

  // True while a `QuestionRow`'s inline "Other" input is open and
  // wants keystrokes. Driven from MessageList → QuestionRow via the
  // onClaimComposerFocus callback. The composer's `focused` prop is
  // forced false while this is true so the inline input — not the
  // composer — receives input; otherwise opentui keeps the composer
  // focused and the user's typing disappears into the chat draft.
  const [questionInlineFocus, setQuestionInlineFocus] = createSignal(false)

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
    // Two-mode toggle: default ↔ plan. kobe's `default` is the
    // trusted-bypass mode — the engine maps it to claude's
    // `bypassPermissions` at spawn time. `acceptEdits` is meaningless
    // for `claude -p` (no interactive protocol), so there is no third
    // mode worth cycling to.
    const next: PermissionMode = current === "plan" ? "default" : "plan"
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
  // Per-task worktree path — feeds the composer's `@`-mention file
  // picker (scoped to the active task's repo checkout, mirrors the
  // FileTree pane's scoping).
  const worktreePath = createMemo<string | undefined>(() => {
    const id = props.taskId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)?.worktreePath ?? undefined
  })
  const modelLabel = createMemo(() => modelLabelFor(modelId()))

  async function chooseModel(): Promise<void> {
    const id = props.taskId()
    if (!id) return
    const result = await ModelPicker.show(dialog, modelId())
    if (result === undefined) return
    await props.orchestrator.setModel(id, result).catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error("[kobe] setModel failed:", err)
    })
  }

  // Scroll-on-reset: snap to bottom on every task-switch / history
  // hydration. useChatSession fires `onTaskReset` for the task-change
  // path; this effect tracks `activeTabId` so external tab switches
  // (or history landing async) re-anchor too.
  createEffect(() => {
    void session.activeTabId()
    queueMicrotask(scrollToBottom)
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

  /**
   * Queue-drain effect. Watches the active tab's `(isStreaming, queue)`
   * pair and dispatches the head of the queue once streaming flips
   * false.
   *
   * Trigger conditions (all required):
   *   - The active tab has a non-empty queue.
   *   - Streaming is false (engine is idle).
   *   - There's no pending user-input picker on the tab (an unresolved
   *     approval/question request blocks new prompts; we wait it out).
   *   - We have a taskId + tabId to dispatch against.
   *
   * Re-entrancy guard. The effect is reactive on `(isStreaming, queue,
   * pendingInput)` — multiple unrelated state changes within one tick
   * could schedule multiple drain microtasks. We hold a boolean lock
   * across the dispatch's async runTask call so the second microtask
   * sees `draining=true` and bails. Without the guard, two queued
   * prompts could hit `runTask` before either has flipped `isStreaming`
   * back to true — the second one's `engine.resume(sid)` then collides
   * with the first's still-being-released session.
   */
  let draining = false
  createEffect(() => {
    const taskId = props.taskId()
    const tabId = activeTabId()
    const state = activeState()
    if (!taskId || !tabId) return
    if (state.isStreaming) return
    if (state.queue.length === 0) return
    if (hasPendingInput()) return
    if (draining) return
    // Dequeue inside a microtask so the createEffect's reactive read
    // graph is settled before we mutate state. Without the defer, the
    // patch races the effect's tracking and we can miss the next tick.
    queueMicrotask(async () => {
      if (draining) return
      const cur = activeState()
      if (cur.isStreaming || cur.queue.length === 0) return
      draining = true
      try {
        let head: { id: string; text: string; ts: string } | null = null
        patchActiveState((s) => {
          const [next, popped] = dequeueFirst(s)
          head = popped
          return next
        })
        // The user row appears via the orchestrator's user.inject
        // event fired at the start of runTask. Pushing it locally
        // here used to be the source of truth, but that bypassed
        // the daemon's broadcast so other attached TUIs never saw
        // the user message — leaving their chat looking like one
        // long unbroken assistant ramble.
        const dispatched = head as { id: string; text: string; ts: string } | null
        if (!dispatched) return
        try {
          await props.orchestrator.runTask(taskId, dispatched.text, tabId)
        } catch (err) {
          patchActiveState((s) => pushSystemError(s, `queued runTask failed: ${stringifyErr(err)}`))
        }
      } finally {
        draining = false
      }
    })
  })

  // Subscription teardown is owned by useChatSession's own onCleanup.

  /**
   * Submit a prompt to the active tab.
   *
   * Three modes, mirroring claude-code's `'now' / 'next' / 'later'`
   * priorities (kobe collapses 'next' into 'later' since `claude -p`
   * is one-shot — no mid-tool insertion point):
   *
   *   - **idle** — turn not in flight, run immediately. (Old default.)
   *   - **queue (mode='auto' default while streaming)** — stash on
   *     {@link ChatState.queue}; the drain effect picks it up when
   *     `isStreaming` flips false.
   *   - **steer (mode='steer')** — ask the orchestrator to interrupt
   *     the in-flight subprocess, then run the new prompt against the
   *     same session id (so the model sees the truncated prior turn
   *     as context).
   *
   * Mode is chosen by the composer key chord: enter = auto, ctrl+enter
   * = steer. Auto-pending-prompt and slash-command paths always pass
   * undefined (= 'auto'); they fire while idle so it doesn't matter.
   */
  async function send(promptText?: string, mode: "auto" | "steer" = "auto"): Promise<void> {
    const text = (promptText ?? draft()).trim()
    const taskId = props.taskId()
    const tabId = activeTabId()
    if (!text || !taskId || !tabId) return
    if (isCanceled()) return
    if (hasPendingInput()) return // approval/question picker has the floor

    // kobe-side slash short-circuit: `/clear` resets the active tab.
    // Handled here (not on the slash entry's onSelect) so a user
    // typing `/clear` directly and pressing Enter — even with the
    // dropdown dismissed — still hits the reset path instead of
    // sending the literal string to the engine.
    if (text === "/clear") {
      setDraft("")
      try {
        await props.orchestrator.clearTab(taskId, tabId)
      } catch (err) {
        patchActiveState((s) => pushSystemError(s, `/clear failed: ${stringifyErr(err)}`))
      }
      return
    }

    const streaming = activeState().isStreaming

    if (streaming && mode === "steer") {
      setDraft("")
      try {
        await props.orchestrator.interruptTask(taskId, tabId)
      } catch (err) {
        patchActiveState((s) => pushSystemError(s, `interrupt failed: ${stringifyErr(err)}`))
        return
      }
      // The pump's `finally` flips isStreaming false via the `done`
      // event; the drain effect won't run because we own the next
      // dispatch. runTask fires user.inject at the start, so the
      // user row lands via the event bus (no local pushUser).
      try {
        await props.orchestrator.runTask(taskId, text, tabId)
      } catch (err) {
        patchActiveState((s) => pushSystemError(s, `runTask failed: ${stringifyErr(err)}`))
      }
      return
    }

    if (streaming) {
      // Queue path. Refuse silently when the soft cap is hit; the
      // composer's footer hint surfaces the cap to the user.
      if (queueIsFull(activeState())) {
        patchActiveState((s) => pushSystemError(s, `queue is full (max ${activeState().queue.length})`))
        return
      }
      setDraft("")
      patchActiveState((s) => enqueuePrompt(s, text))
      return
    }

    // Idle path. runTask fires user.inject at the start, so the
    // user row lands via the event bus (no local pushUser).
    setDraft("")
    try {
      await props.orchestrator.runTask(taskId, text, tabId)
    } catch (err) {
      patchActiveState((s) => pushSystemError(s, `runTask failed: ${stringifyErr(err)}`))
    }
  }

  /**
   * Cancel one queued prompt by id. Called by the cancel-button on
   * each `QueuedPromptList` row.
   */
  function cancelQueued(id: string): void {
    patchActiveState((s) => removeFromQueue(s, id))
  }

  /** Create a new tab and switch focus to it. Wired from `ctrl+t`. */
  async function newTab(): Promise<void> {
    const taskId = props.taskId()
    if (!taskId) return
    try {
      const tab = await props.orchestrator.createTab(taskId)
      setActiveTabIdLocal(tab.id)
      setExpandedToolIndex(null)
      setExpandedFoldStartIndex(null)
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
      // The controller's syncTabSubs drops the orphan tab's state +
      // draft on the next reactive tick when `tasks` updates — no
      // manual cleanup needed here.
      if (nextActive) {
        setActiveTabIdLocal(nextActive)
        setExpandedToolIndex(null)
        setExpandedFoldStartIndex(null)
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
    setExpandedToolIndex(null)
    setExpandedFoldStartIndex(null)
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
  // No numeric pick — chat tabs cycle via ctrl+[/ctrl+] so ctrl+1..4
  // is uncontested as the global pane-focus chord (see
  // docs/KEYBINDINGS.md).
  useBindings(() => ({
    enabled: props.focused?.() === true,
    bindings: bindByIds({
      "chat.tab.new": () => void newTab(),
      "chat.tab.close": () => void closeActiveTab(),
      "chat.tab.cycle-next": () => cycleTab(1),
      "chat.tab.cycle-prev": () => cycleTab(-1),
      "chat.tab.rename": () => {
        const id = activeTabId()
        if (id) props.onRenameTabRequest?.(id)
      },
      "chat.session.resume": () => {
        const tid = props.taskId()
        if (!tid) return
        ResumeDialog.show(dialog, props.orchestrator, tid)
      },
    }),
  }))

  // Esc-to-interrupt while streaming. Higher precedence than the global
  // `focus.detach` esc (LIFO stack — Chat mounts after the global hook,
  // so this binding sits on top). Gated on `streaming` so an idle ESC
  // still falls through to the global handler and detaches to the
  // sidebar; gated on `!dialog.stack.length` so DialogProvider's esc
  // (close top dialog) isn't shadowed.
  async function interruptStream(): Promise<void> {
    const taskId = props.taskId()
    const tabId = activeTabId()
    if (!taskId || !tabId) return
    if (!activeState().isStreaming) return
    try {
      await props.orchestrator.interruptTask(taskId, tabId)
    } catch (err) {
      patchActiveState((s) => pushSystemError(s, `interrupt failed: ${stringifyErr(err)}`))
    }
  }
  useBindings(() => ({
    enabled: props.focused?.() === true && activeState().isStreaming && dialog.stack.length === 0,
    bindings: [{ key: "escape", cmd: () => void interruptStream() }],
  }))

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

  function toggleFold(startIndex: number): void {
    setExpandedFoldStartIndex((cur) => (cur === startIndex ? null : startIndex))
  }

  function handleComposerSubmit(trimmed: string, mode: "auto" | "steer" = "auto"): void {
    if (trimmed.length === 0) {
      if (lastToolIndex() !== null) toggleExpandLastTool()
      return
    }
    // If a question picker is up, the composer's content is the user's
    // free-text answer — same role as picking the auto-added "Other"
    // option. Route through respondToInput so the orchestrator emits
    // the right synthetic resume prompt; sending it as a fresh prompt
    // instead would race the still-pending AskUserQuestion tool_result
    // and the model would not know which input is the answer. Every
    // question on the picker gets the same answer string — multi-
    // question prompts are rare, and the alternative (only answer the
    // first, leave the rest unanswered) violates the picker's
    // all-questions-required contract.
    const q = pendingQuestion()
    if (q) {
      const taskId = props.taskId()
      if (!taskId) return
      const answers: Record<string, string> = {}
      for (const entry of q.questions) {
        answers[entry.question] = trimmed
      }
      props.orchestrator
        .respondToInput(taskId, q.requestId, { kind: "ask_question", answers })
        .catch((err: unknown) => {
          patchActiveState((s) => pushSystemError(s, `respondToInput failed: ${stringifyErr(err)}`))
        })
      setDraft("")
      return
    }
    // `trimmed` is the composer's post-expansion text — `[Image #N]`
    // placeholders have already been rewritten to ` @/abs/path ` so
    // claude's `-p` mention parser can attach the image. Falling back
    // to `draft()` here would silently drop the attachments because
    // the draft signal mirrors the literal textarea content.
    void send(trimmed, mode)
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
              expandedToolIndex={expandedToolIndex()}
              onToggleTool={toggleExpand}
              expandedFoldStartIndex={expandedFoldStartIndex()}
              onToggleFold={toggleFold}
              showEmptyPlaceholder={!showThinking()}
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
              onClaimComposerFocus={setQuestionInlineFocus}
            />
          </box>
        </scrollbox>
      </Show>

      {/* Thinking spinner — pinned just above the composer, OUTSIDE the
          scrolling transcript. Mirrors `refs/claude-code/src/screens/REPL.tsx`
          (SpinnerWithVerb sits above the bottom prompt, not inside the
          message list) so the spinner always reads as the live status
          line regardless of where the user has scrolled. Keeping it
          outside the scrollbox also avoids the ordering ambiguity that
          showed up when Loading was the last child of an opentui flex
          column alongside a reactive <For> — its position is now
          deterministic by source order at this layer. */}
      {/* Queued prompts — sits between the spinner and the composer
          so the user can see what's pending before the next turn fires.
          Each row has a [x] cancel affordance; clicking it drops the
          entry from the queue without dispatching. Empty queue =
          nothing renders. Mirrors the visual placement of claude-code's
          `QueuedCommandsDisplay` (above the prompt input) so the user
          finds the affordance at the same eye level. */}
      <Show when={props.taskId() && activeState().queue.length > 0}>
        <QueuedPromptList queue={activeState().queue} onCancel={cancelQueued} />
      </Show>

      <Show when={showThinking() && props.taskId()}>
        <Loading startedAt={turnStartedAt()} responseChars={currentTurnChars()} />
      </Show>

      {/* Composer — hidden entirely while a question picker is up so
          the user's full attention is on picking (or typing into the
          inline "Other" input). Reappears as soon as the picker
          resolves; the user can then type freely again. Approval
          pickers (ExitPlanMode) keep the composer rendered but locked
          since approval is binary and the user might still want
          history / model context affordances visible. */}
      <Show when={!pendingQuestion()}>
        <Composer
          draft={draft()}
          onDraftChange={setDraft}
          isStreaming={activeState().isStreaming}
          hasTask={props.taskId() !== undefined && !isCanceled() && !pendingApproval()}
          noTaskMessage={
            isCanceled()
              ? "(task canceled — pick another or press ctrl+n to create)"
              : pendingApproval()
                ? "(answer the prompt above to continue)"
                : undefined
          }
          onSubmit={handleComposerSubmit}
          focused={() => (props.focused?.() ?? false) && !questionInlineFocus()}
          // Per-tab history scope — prompt history shouldn't bleed across tabs.
          historyKey={activeTabId() ?? props.taskId()}
          slashes={slashes}
          permissionMode={permissionMode}
          onCyclePermissionMode={cyclePermissionMode}
          modelLabel={modelLabel}
          onChooseModel={() => void chooseModel()}
          worktreePath={worktreePath}
        />
      </Show>
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

/**
 * Mid-stream user prompts the user chose to QUEUE (plain enter while
 * streaming). Renders one row per pending prompt with a `+` prefix
 * (the `>` chip is reserved for dispatched user rows in the transcript)
 * and a clickable `[x]` cancel chip. Lives outside the scrollbox so
 * it shares horizontal layout with the spinner and composer — the user
 * finds queued prompts at the same eye-line as the live status row,
 * not buried inside the scrollback.
 *
 * Caps the visible rows at {@link QUEUE_VISIBLE_CAP} so a fast typist
 * who queued 30 prompts doesn't push the composer off-screen. Excess
 * shows as a single muted `+ … N more queued` summary row at the
 * bottom — same shape claude-code uses for its task-notification
 * overflow (`refs/claude-code/src/components/PromptInput/
 * PromptInputQueuedCommands.tsx:33-40`). The full queue still lives
 * in state; cancellation just isn't reachable for hidden rows until
 * earlier ones drain or get cancelled.
 *
 * Tone is intentionally muted: queued prompts haven't reached the
 * model yet, so we don't paint them as accent-coloured the way an
 * in-flight user message gets the `theme.accent` `>` chip.
 */
const QUEUE_VISIBLE_CAP = 4

function QueuedPromptList(props: {
  queue: readonly { id: string; text: string }[]
  onCancel: (id: string) => void
}) {
  const { theme } = useTheme()
  const visible = () => props.queue.slice(0, QUEUE_VISIBLE_CAP)
  const hidden = () => Math.max(0, props.queue.length - QUEUE_VISIBLE_CAP)
  return (
    <box flexDirection="column" gap={0} paddingTop={1} paddingLeft={1} paddingRight={1}>
      <For each={visible()}>
        {(entry, idx) => (
          <box flexDirection="row" gap={1} alignItems="flex-start">
            <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
              +
            </text>
            <box flexGrow={1} flexDirection="row" gap={1}>
              <text fg={theme.textMuted} wrapMode="none">
                queued{idx() === 0 ? " (next)" : ""}:
              </text>
              <box flexGrow={1}>
                <text fg={theme.text}>{entry.text}</text>
              </box>
              <text fg={theme.error} attributes={TextAttributes.BOLD} onMouseUp={() => props.onCancel(entry.id)}>
                [x]
              </text>
            </box>
          </box>
        )}
      </For>
      <Show when={hidden() > 0}>
        <box flexDirection="row" gap={1} alignItems="flex-start">
          <text fg={theme.textMuted} attributes={TextAttributes.BOLD}>
            +
          </text>
          <text fg={theme.textMuted}>{`… ${hidden()} more queued`}</text>
        </box>
      </Show>
    </box>
  )
}
