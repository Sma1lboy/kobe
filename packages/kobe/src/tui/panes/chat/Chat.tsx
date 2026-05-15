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

import { getCapabilities, getIdentity, modelLabelFor } from "@/engine/registry"
import type { ScrollBoxRenderable } from "@opentui/core"
import { type Accessor, createEffect, createMemo, createSignal, on, onMount } from "solid-js"
import type { KobeOrchestrator } from "../../../client/remote-orchestrator.ts"
import type { PermissionMode } from "../../../types/engine.ts"
import { useTheme } from "../../context/theme"
import { useBindings } from "../../lib/keymap"
import { useDialog } from "../../ui/dialog"
import { ChatView } from "./ChatView"
import type { ComposerSlashEntry } from "./Composer"
import { estimateContextTokensFromRows, stringifyErr } from "./chat-utils"
import { ModelPicker } from "./composer/ModelPicker"
import { BUILTIN_CLAUDE_SLASHES, type BuiltinSlash } from "./composer/builtin-slashes"
import { permissionModeLabel } from "./composer/permission-mode"
import { loadUserSlashes } from "./composer/user-slashes"
import { formatContextUsageCompact } from "./context-meter"
import { answerQuestionWithFreeText, pendingInputPaneState } from "./pending-input-pane-state"
import {
  type ChatState,
  QUEUE_SOFT_CAP,
  type QueuedPrompt,
  createInitialState,
  dequeueFirst,
  enqueuePrompt,
  pushSystemError,
  queueIsFull,
  removeFromQueue,
  updateQueueItem,
} from "./store"
import { useBashMode } from "./use-bash-mode"
import { useChatSession } from "./use-chat-session"
import { useChatTabs } from "./use-chat-tabs"

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
  /**
   * Open a worktree-relative path from the composer in the workspace
   * file preview tab. The parent owns center-tab state, so Chat only
   * forwards the request.
   */
  onOpenFilePath?: (relPath: string) => void
  /**
   * Quick-fork callback (KOB-74). Fires on `ctrl+f` from a focused
   * chat tab; the parent opens QuickForkDialog seeded with the active
   * task's repo/branch/model and dispatches the first prompt against
   * the resulting child task. Chat owns the chord but not the
   * orchestrator coupling — the parent already has those handles.
   */
  onQuickForkRequest?: () => void
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
  // Id of the queue entry currently being edited via click-to-edit.
  // Chat-scoped (not per-tab) — switching tabs implicitly resets via
  // the createEffect below that watches the active tab's queue.
  const [editingQueueId, setEditingQueueId] = createSignal<string | null>(null)

  // Drop edit state when the target queue entry leaves the active tab's
  // queue (cancelled, drained by the streaming finish effect, or the
  // user switched tabs to a tab whose queue doesn't contain that id).
  createEffect(() => {
    const id = editingQueueId()
    if (id === null) return
    const present = activeState().queue.some((q) => q.id === id)
    if (!present) setEditingQueueId(null)
  })

  const tasksAcc = props.orchestrator.tasksSignal()

  // Active task's repo root (the worktree's parent project, NOT the
  // worktree itself). Threaded to Composer for KOB-157 persistence —
  // stamped onto every disk-persisted history entry so a future
  // session can filter the palette per-project. `undefined` when no
  // task is selected; persistence falls back to the global bucket.
  const currentProjectRoot = createMemo<string | undefined>(() => {
    const tid = props.taskId()
    if (!tid) return undefined
    return props.orchestrator.getTask(tid)?.repo
  })

  // Reverse-lookup for the Ctrl+R prompt-history palette (KOB-154).
  // Composer keys per-tab history rings by `chatTab.id`, occasionally
  // by task id (fallback when no tab is set), or the literal "global".
  // The palette renders rows as `<task-title>  ·  <prompt>`, so we
  // walk the live task list to map either of those id shapes back to
  // a title. Walk cost is O(tasks * tabs-per-task); both are small
  // (typically < 100 entries combined), and the palette opens
  // interactively — cheap enough to call once per render.
  function taskLabelForHistoryKey(historyKey: string): string | undefined {
    if (historyKey === "global") return undefined
    const tasks = tasksAcc()
    for (const t of tasks) {
      if (t.id === historyKey) return t.title
      if (t.tabs.some((tab) => tab.id === historyKey)) return t.title
    }
    return undefined
  }

  const contextMeterLabel = createMemo(() => {
    const tid = props.taskId()
    const tabId = activeTabId()
    if (!tid || !tabId) return null
    const st = statesByTab().get(tabId)
    const u = st?.lastUsage
    if (!u) return null
    const task = props.orchestrator.getTask(tid)
    const tab = task?.tabs.find((t) => t.id === tabId)
    const vendor = tab?.vendor ?? task?.vendor ?? "claude"
    const modelId = tab?.model ?? task?.model ?? getCapabilities(vendor).defaultModelId()
    const displayUsage =
      vendor === "codex" && u.context_window_tokens && !u.context_tokens
        ? {
            ...u,
            context_tokens: estimateContextTokensFromRows(st.messages),
            context_tokens_approximate: true,
          }
        : u
    return formatContextUsageCompact(displayUsage, modelId, vendor)
  })

  createEffect(
    on(contextMeterLabel, (label) => {
      props.onContextMeter?.(label ?? null)
    }),
  )

  // Reactive view of the active task's status. `canceled` blocks the
  // composer because the orchestrator rejects `canceled → in_progress`.
  const activeTask = createMemo(() => {
    const id = props.taskId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)
  })
  const taskStatus = () => activeTask()?.status
  const isCanceled = () => taskStatus() === "canceled"
  const isArchived = () => activeTask()?.archived === true

  const pendingInput = createMemo(() => pendingInputPaneState(activeState()))
  const pendingApproval = createMemo(() => pendingInput().approval)
  const pendingQuestion = createMemo(() => pendingInput().question)
  const hasPendingInput = createMemo(() => pendingInput().blocksPromptDispatch)

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
    const task = tasksAcc().find((t) => t.id === id)
    const tab = task?.tabs.find((t) => t.id === activeTabId())
    return tab?.model ?? task?.model
  })
  const modelEffort = createMemo(() => {
    const id = props.taskId()
    if (!id) return undefined
    const task = tasksAcc().find((t) => t.id === id)
    const tab = task?.tabs.find((t) => t.id === activeTabId())
    return tab?.modelEffort ?? task?.modelEffort
  })
  // Per-task worktree path — feeds the composer's `@`-mention file
  // picker (scoped to the active task's repo checkout, mirrors the
  // FileTree pane's scoping).
  const worktreePath = createMemo<string | undefined>(() => {
    const id = props.taskId()
    if (!id) return undefined
    return tasksAcc().find((t) => t.id === id)?.worktreePath ?? undefined
  })
  const bashMode = useBashMode({
    taskId: () => props.taskId(),
    activeTabId,
    activeState,
    worktreePath,
    patchActiveState,
    patchStateForTab,
  })
  const {
    abortTab: abortBashForTab,
    drainBashContextPrefix,
    handleBashCommand,
    hasActiveBash,
    runBashLocally,
  } = bashMode
  const activeVendor = createMemo(() => {
    const id = props.taskId()
    const task = id ? tasksAcc().find((t) => t.id === id) : undefined
    const tab = task?.tabs.find((t) => t.id === activeTabId())
    return tab?.vendor ?? task?.vendor ?? "claude"
  })
  const activeTabHasSession = createMemo(() => {
    const id = props.taskId()
    const task = id ? tasksAcc().find((t) => t.id === id) : undefined
    const tab = task?.tabs.find((t) => t.id === activeTabId())
    return !!tab?.sessionId
  })
  const modelLabel = createMemo(() =>
    modelLabelFor(modelId() ?? getCapabilities(activeVendor()).defaultModelId(), modelEffort()),
  )
  const permissionModeText = createMemo(() => permissionModeLabel(getCapabilities(activeVendor()), permissionMode()))
  const inputPlaceholder = createMemo(() => {
    return getIdentity(activeVendor()).inputPlaceholder
  })

  async function chooseModel(): Promise<void> {
    const id = props.taskId()
    if (!id) return
    const tabId = activeTabId() ?? undefined
    const lockedVendor = activeTabHasSession() ? activeVendor() : undefined
    const result = await ModelPicker.show(dialog, modelId(), modelEffort(), activeVendor(), lockedVendor)
    if (result === undefined) return
    await props.orchestrator.setModel(id, result.id, tabId, result.effort).catch((err: unknown) => {
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
   * sees `dispatching=true` and bails. Without the guard, two queued
   * prompts could hit `runTask` before either has flipped `isStreaming`
   * back to true — the second one's `engine.resume(sid)` then collides
   * with the first's still-being-released session.
   *
   * The same lock is held by the steer path in {@link send} (and by
   * extension {@link sendQueuedNow}). Without that extension, a user
   * who clicks `[↑]` on a queued prompt while two other prompts sit in
   * the queue races: `interruptTask` flips `isStreaming` false via the
   * `done` event in the gap between `await interruptTask` and
   * `await runTask`, the drain effect wakes up, pops the head, and now
   * we have two concurrent `runTask` calls fighting for the same
   * session id — engine logs "claude session ended:
   * error_during_execution" for each loser.
   */
  // Reactive lock so the effect re-fires when a bash drain finishes.
  // The earlier plain-variable lock worked for the prompt-only path
  // because `runTask` flipped `isStreaming` true→false via user.inject
  // / done events, and each toggle re-triggered the effect to drain
  // the next item. Bash items don't touch `isStreaming`, so without a
  // tracked lock the effect doesn't see `dispatching` flip back to
  // false after `await runBashLocally`, and any items behind a bash
  // entry in the queue would sit there until the user manually pokes
  // some other reactive state (KOB-83 queue-chain regression).
  const [dispatching, setDispatching] = createSignal(false)
  createEffect(() => {
    const taskId = props.taskId()
    const tabId = activeTabId()
    const state = activeState()
    if (!taskId || !tabId) return
    if (state.isStreaming) return
    if (state.queue.length === 0) return
    if (hasPendingInput()) return
    if (dispatching()) return
    // Dequeue inside a microtask so the createEffect's reactive read
    // graph is settled before we mutate state. Without the defer, the
    // patch races the effect's tracking and we can miss the next tick.
    queueMicrotask(async () => {
      if (dispatching()) return
      const cur = activeState()
      if (cur.isStreaming || cur.queue.length === 0) return
      setDispatching(true)
      try {
        let head: QueuedPrompt | null = null
        patchActiveState((s) => {
          const [next, popped] = dequeueFirst(s)
          head = popped
          return next
        })
        // The `as` cast is load-bearing: TS doesn't trust that the
        // patchActiveState callback ran synchronously, so it narrows
        // `head` to `null` (its initialization value) and the kind
        // check below collapses to `never`. The original (pre-bash)
        // code carried the same cast for the same reason.
        const dispatched = head as QueuedPrompt | null
        if (!dispatched) return
        // Route by kind. Bash items run locally via runBashLocally
        // (which awaits the subprocess) — serial with whatever else
        // is queued. Prompt items run the engine turn with bash
        // context prepended. Mirrors claude-code's drain in
        // `executeUserInput`: each queued command goes through
        // `processUserInput`, which forks on `mode === 'bash'` vs
        // prompt without breaking the queue's FIFO semantics.
        if (dispatched.kind === "bash") {
          // Awaiting here keeps the queue serial — the effect re-runs
          // on the next reactive tick and drains the next item only
          // after this bash exits. A long-running command (`!sleep 60`)
          // blocks subsequent prompts until it finishes or the user
          // Escs the abort.
          await runBashLocally(dispatched.command)
          return
        }
        // The user row appears via the orchestrator's user.inject
        // event fired at the start of runTask. Pushing it locally
        // here used to be the source of truth, but that bypassed
        // the daemon's broadcast so other attached TUIs never saw
        // the user message — leaving their chat looking like one
        // long unbroken assistant ramble.
        //
        // Drain pending !bash context HERE (at dispatch time), not at
        // enqueue time. A bash command that runs WHILE a prompt sits
        // in the queue should attach its context to that prompt (the
        // model sees the bash output immediately preceding the user's
        // intent), not drift to the prompt after. Mirrors claude-code's
        // conversation semantics where bash messages join history at
        // the moment they execute.
        const bashPrefix = drainBashContextPrefix()
        const finalText = bashPrefix.length > 0 ? bashPrefix + dispatched.text : dispatched.text
        try {
          await props.orchestrator.runTask(taskId, finalText, tabId)
        } catch (err) {
          patchActiveState((s) => pushSystemError(s, `queued runTask failed: ${stringifyErr(err)}`))
        }
      } finally {
        setDispatching(false)
      }
    })
  })

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

    // Drain `!bash` context here for the IMMEDIATE-dispatch paths (idle
    // and steer). Queue path defers the drain to the queue-drain
    // microtask above so bash commands that complete WHILE the prompt
    // sits in the queue still attach to that prompt, not the one after
    // — matches claude-code's "bash messages join conversation history
    // at the moment they execute" semantics.
    const immediate = !streaming || mode === "steer"
    const bashPrefix = immediate ? drainBashContextPrefix() : ""
    const dispatched = bashPrefix.length > 0 ? bashPrefix + text : text

    if (streaming && mode === "steer") {
      setDraft("")
      // Claim the dispatch lock BEFORE awaiting steer. Without this,
      // the `done` event from the killed subprocess flips `isStreaming`
      // false while steerTask is mid-execution — and the drain effect
      // wakes up to pop the head of the queue, giving us two
      // concurrent runTasks fighting for the same session id. Bail if
      // another dispatch already owns the lock; the user can re-click
      // rather than queue another race.
      if (dispatching()) return
      setDispatching(true)
      try {
        // steerTask owns the interrupt + run-with-merged-prompt
        // sequence atomically on the orchestrator side. Critically,
        // it captures the in-flight prompt BEFORE the kill so the
        // model still sees what the user had been saying — claude -p
        // never persists a mid-stream user turn to its JSONL log on
        // its own, so a naive interrupt+resume would drop the
        // abandoned prompt entirely.
        try {
          await props.orchestrator.steerTask(taskId, dispatched, tabId)
        } catch (err) {
          patchActiveState((s) => pushSystemError(s, `steer failed: ${stringifyErr(err)}`))
        }
      } finally {
        setDispatching(false)
      }
      return
    }

    if (streaming) {
      // Queue path. Refuse silently when the soft cap is hit; the
      // composer's footer hint surfaces the cap to the user.
      if (queueIsFull(activeState())) {
        patchActiveState((s) => pushSystemError(s, `queue is full (max ${QUEUE_SOFT_CAP})`))
        return
      }
      setDraft("")
      // Stash the user's RAW text; the queue-drain microtask folds in
      // whatever bash context is pending at dispatch time. Storing
      // `dispatched` (with prefix) would freeze stale context onto the
      // queued prompt.
      patchActiveState((s) => enqueuePrompt(s, text))
      return
    }

    // Idle path. runTask fires user.inject at the start, so the
    // user row lands via the event bus (no local pushUser).
    setDraft("")
    try {
      await props.orchestrator.runTask(taskId, dispatched, tabId)
    } catch (err) {
      patchActiveState((s) => pushSystemError(s, `runTask failed: ${stringifyErr(err)}`))
    }
  }

  /**
   * Cancel one queued prompt by id. Called by the cancel-button on
   * each queued row inside the composer. If the cancelled item was
   * the one being edited, the createEffect that watches queue
   * membership tears down `editingQueueId` on the next tick.
   */
  function cancelQueued(id: string): void {
    patchActiveState((s) => removeFromQueue(s, id))
  }

  /**
   * Promote a queued prompt to "send now". Pulls it out of the queue
   * and re-dispatches via the steer path — interrupts the in-flight
   * turn and runs the chosen prompt against the same session, so the
   * user doesn't have to wait for the head to drain naturally. Idle
   * fallback (queue should normally be empty when idle, but the drain
   * effect runs on a microtask so there's a brief race window) just
   * calls send normally.
   */
  function sendQueuedNow(id: string): void {
    const entry = activeState().queue.find((q) => q.id === id)
    if (!entry) return
    patchActiveState((s) => removeFromQueue(s, id))
    if (entry.kind === "bash") {
      // Bash items in the queue can't "steer" — there's no engine turn
      // to interrupt for a local shell call. Promote to immediate
      // execution instead; aborts whatever bash is currently in-flight
      // for the tab (matches the abort-prior rule in runBashLocally).
      void runBashLocally(entry.command)
      return
    }
    void send(entry.text, "steer")
  }

  /**
   * Begin editing a queued prompt: load its text into the composer
   * draft and remember the id so the next submit replaces the entry
   * in place instead of dispatching a new prompt. Clicking a different
   * queued row while already editing swaps the target (any uncommitted
   * draft text on the previous target is discarded — pressing Enter
   * is the only way to commit).
   */
  function editQueued(id: string): void {
    const entry = activeState().queue.find((q) => q.id === id)
    if (!entry || entry.kind !== "prompt") return
    setEditingQueueId(id)
    setDraft(entry.text)
  }

  // Pane-scoped keybindings: only fire when the chat pane is focused.
  // No numeric pick — chat tabs cycle via ctrl+[/ctrl+] so ctrl+1..4
  // is uncontested as the global pane-focus chord (see
  // docs/KEYBINDINGS.md).
  useChatTabs({
    orchestrator: props.orchestrator,
    dialog,
    taskId: () => props.taskId(),
    focused: props.focused,
    tabs,
    activeTabId,
    setActiveTabIdLocal,
    setExpandedToolIndex,
    setExpandedFoldStartIndex,
    patchActiveState,
    abortBashForTab,
    onRenameTabRequest: props.onRenameTabRequest,
    onQuickForkRequest: props.onQuickForkRequest,
  })

  // Esc-to-interrupt while streaming OR while a `!bash` command is
  // running. Gated on at least one of those being true so an idle ESC
  // is a no-op (the global "back to sidebar" detach was removed because
  // it pulled focus out from under the user mid-edit; use `ctrl+q` for
  // an explicit detach). Gated on `!dialog.stack.length` so
  // DialogProvider's esc (close top dialog) isn't shadowed.
  async function interruptStream(): Promise<void> {
    const taskId = props.taskId()
    const tabId = activeTabId()
    if (!taskId || !tabId) return
    // Abort any in-flight bash for this tab first — local, synchronous.
    // The runBashLocally handler watches signal.aborted and skips the
    // pending-context stash, so the cancelled run doesn't leak into the
    // next prompt.
    abortBashForTab(tabId)
    if (!activeState().isStreaming) return
    try {
      await props.orchestrator.interruptTask(taskId, tabId)
    } catch (err) {
      patchActiveState((s) => pushSystemError(s, `interrupt failed: ${stringifyErr(err)}`))
    }
  }
  useBindings(() => ({
    enabled: props.focused?.() === true && (activeState().isStreaming || hasActiveBash()) && dialog.stack.length === 0,
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
    // Click-to-edit commit: when a queue entry is being edited, the
    // composer's submit replaces that entry's text in place instead
    // of dispatching a new prompt. Empty trimmed text deletes the
    // entry (same semantics as the [x] cancel button). If the target
    // already left the queue mid-edit (the drain effect popped it),
    // fall through to the normal send path so the user's text isn't
    // silently dropped.
    const editingId = editingQueueId()
    if (editingId !== null) {
      const stillQueued = activeState().queue.some((q) => q.id === editingId)
      if (stillQueued) {
        setEditingQueueId(null)
        if (trimmed.length === 0) {
          patchActiveState((s) => removeFromQueue(s, editingId))
        } else {
          patchActiveState((s) => updateQueueItem(s, editingId, trimmed))
        }
        setDraft("")
        return
      }
      setEditingQueueId(null)
    }
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
      props.orchestrator
        .respondToInput(taskId, q.requestId, answerQuestionWithFreeText(q, trimmed))
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
    <ChatView
      theme={theme}
      hasTaskId={props.taskId() !== undefined}
      setScrollRef={(r) => {
        scrollRef = r
      }}
      messages={activeState().messages}
      expandedToolIndex={expandedToolIndex()}
      onToggleTool={toggleExpand}
      expandedFoldStartIndex={expandedFoldStartIndex()}
      onToggleFold={toggleFold}
      showThinking={showThinking()}
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
      chatFocused={() => props.focused?.() ?? false}
      loadingStartedAt={turnStartedAt()}
      currentTurnChars={currentTurnChars()}
      error={activeState().error}
      showComposer={pendingInput().showsComposer}
      draft={draft()}
      onDraftChange={setDraft}
      isStreaming={activeState().isStreaming}
      composerHasTask={props.taskId() !== undefined && !isArchived() && !isCanceled() && !pendingInput().locksComposer}
      noTaskMessage={
        isArchived()
          ? "(archived — unarchive to resume)"
          : isCanceled()
            ? "(task canceled — pick another or press ctrl+n to create)"
            : pendingInput().composerDisabledMessage
              ? pendingInput().composerDisabledMessage
              : undefined
      }
      onSubmit={handleComposerSubmit}
      composerFocused={() => (props.focused?.() ?? false) && !questionInlineFocus()}
      historyKey={activeTabId() ?? props.taskId()}
      slashes={slashes}
      permissionMode={permissionMode}
      permissionModeLabel={permissionModeText}
      onCyclePermissionMode={cyclePermissionMode}
      modelLabel={modelLabel}
      inputPlaceholder={() => pendingInput().composerPlaceholder ?? inputPlaceholder()}
      onChooseModel={() => void chooseModel()}
      worktreePath={worktreePath}
      queue={() => activeState().queue}
      onCancelQueued={cancelQueued}
      onSendQueuedNow={sendQueuedNow}
      onBashCommand={handleBashCommand}
      onOpenFilePath={props.onOpenFilePath}
      onEditQueued={editQueued}
      editingQueueId={editingQueueId}
      taskLabelForHistoryKey={taskLabelForHistoryKey}
      currentProjectRoot={currentProjectRoot}
    />
  )
}
