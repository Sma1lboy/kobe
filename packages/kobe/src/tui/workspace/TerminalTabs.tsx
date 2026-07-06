/**
 * Workspace terminal tabs (issue #16) — the PTY-world chattab. A strip of
 * engine-terminal tabs above the embedded Terminal pane; every tab runs
 * an interactive engine command in its own PTY (registry key
 * `${taskId}::${tabId}`), so ctrl+t gives a parallel session in the same
 * worktree exactly like the tmux chattab did with windows. Plain ctrl+t
 * inherits the task's current engine; ctrl+e prompts for one instead
 * (`chat.tab.chooseEngine`, tmux's `ctrl+shift+t` equivalent) and pins it
 * to just that tab via `TerminalTab.vendor`.
 *
 * Chords reuse the canonical chattab binding ids (keybindings-chat.ts):
 * ctrl+t new · ctrl+e new-with-engine · ctrl+w close (last tab refuses) ·
 * F2 rename · ctrl+]/[ cycle. They are reserved from PTY passthrough in
 * keys-pure.ts — same interception the tmux root key-table performed.
 *
 * Per-task tab state lives in a module-level map so switching tasks and
 * back preserves each task's tabs (their PTYs already survive via the
 * registry's acquire-reuse).
 */

import type { TranscriptActivity } from "@/client/remote-orchestrator"
import { availableEngineIds } from "@/engine/account-detect"
import { interactiveEngineCommand, withClaudeSessionId } from "@/engine/interactive-command"
import { engineEntry } from "@/engine/registry"
import type { ChatTabTurnState } from "@/engine/turn-detector"
import { deriveTitleFromSessionId } from "@/monitor/auto-title"
import { resolveMainRepoRoot } from "@/state/repos"
import { setRepoLastActiveVendor } from "@/state/vendor-prefs"
import type { VendorId } from "@/types/vendor"
import { TextAttributes } from "@opentui/core"
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import { EnginePickerDialog } from "../component/engine-picker-dialog/index"
import { RenameTaskDialog } from "../component/rename-task-dialog/index"
import { bindByIds } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import { startTurnStatusPoll } from "../ops/activity-monitor"
import type { Terminal } from "../panes/terminal/Terminal"
import { defaultShell } from "../panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"
import { useDialog } from "../ui/dialog"
import { TerminalSplit, releaseSplitLeaves } from "./TerminalSplit"
import {
  type EngineTab,
  type TabsState,
  type TerminalTab,
  addTab,
  closeActiveTab,
  closeTab,
  cycleTab,
  initialTabs,
  markTabSpawned,
  openEditorTab,
  rehydrateTabs,
  renameActiveTab,
  selectTab,
  setTabAutoTitle,
  setTabSessionId,
  tabPtyKey,
  tabToShell,
} from "./terminal-tabs-core"

/** Per-task tab state, preserved across task switches for the process. */
const tabsByTask = new Map<string, TabsState>()

/** Cadence of the tab auto-naming pass (tmux ran its pass on the monitor tick). */
const NAMING_POLL_MS = 5000
/** Cadence of the lazy turn-poll attach retry (a tab's PTY spawns after mount). */
const TURN_POLL_ATTACH_MS = 2000

/** Same glyph vocabulary as tmux's `CHAT_TAB_STATUS_FORMAT` (`@kobe_tab_state`). */
const TURN_GLYPHS: Record<ChatTabTurnState, string> = {
  running: "●",
  done: "✓",
  error: "!",
  unknown: "?",
  idle: "○",
}

function tabTitle(tab: TerminalTab): string {
  // Manual rename wins; the auto-derived first-prompt title is the
  // fallback; the numbered default is last — tmux automatic-rename order.
  return tab.title ?? tab.autoTitle ?? t("terminal.tab.defaultTitle", { n: tab.ordinal })
}

export function TerminalTabs(props: {
  taskId: string
  worktree: string
  command: readonly string[]
  /** Task's current engine + effort — used to build a per-tab command when
   *  a tab pins its own vendor via `chooseEngine`. */
  vendor: VendorId
  modelEffort?: string
  /** Best-effort: persist the picked vendor as the task's new default
   *  (mirrors tmux chattab's `rememberSessionVendor`). Omit to skip. */
  onChooseEngine?: (vendor: VendorId) => void
  /**
   * Hands the parent an imperative "open this file in a new editor tab"
   * function, called once on mount. Needed because tab state is private to
   * this component (module-scoped `tabsByTask` + a local signal) — the
   * FileTree pane's "open" action lives in `workspace/host.tsx`, a sibling,
   * not a descendant, so it can't reach `openEditorTab` any other way.
   * Re-fires on every remount (task/worktree switch — see the `keyed` Show
   * in `host.tsx`), rebinding to that mount's own tab state.
   */
  onEditorTabReady?: (open: (command: readonly string[], label: string) => void) => void
  /**
   * This worktree's slice of the daemon's `transcript.activity` push
   * (issue #24) — feeds the turn-status loops' shared mode (adaptive
   * capture cadence + push-driven completion reads). Omitted/null =
   * fallback mode (fixed-cadence local polling), same contract as the
   * Ops pane.
   */
  sharedActivity?: () => TranscriptActivity | null
  focused: () => boolean
}): ReturnType<typeof Terminal> {
  const { theme } = useTheme()
  const dialog = useDialog()
  const notif = useNotifications()
  const kv = useKV()
  const persistKey = `terminalTabs.${props.taskId}`

  /** Pin a fresh engine-session id on the just-created active engine tab —
   *  the tmux `@kobe_session_id` stash. Only the ID is state; the argv
   *  mapping happens at render (`engineTabCommand`), so a remount of a
   *  surviving PTY reuses the same id. Codex/custom pin nothing (null). */
  const pinSession = (s: TabsState, vendor: VendorId | undefined): TabsState => {
    const base = vendor ? interactiveEngineCommand(vendor, props.modelEffort) : props.command
    const { sessionId } = withClaudeSessionId(base, vendor ?? props.vendor)
    return setTabSessionId(s, s.activeId, sessionId)
  }

  const initState = (): TabsState => {
    const existing = tabsByTask.get(props.taskId)
    if (existing) return existing
    // Restart survival (issue #22): rehydrate the persisted engine-tab
    // snapshot (titles/ordinals/sessionIds — command tabs are transient
    // and dropped) before falling back to a fresh single tab.
    const saved = kv.get(persistKey, null) as TabsState | null
    const fresh = saved && Array.isArray(saved.tabs) ? rehydrateTabs(saved) : pinSession(initialTabs(), undefined)
    // Persist immediately so a remount before the first mutation doesn't
    // re-pin a different session id against the already-spawned PTY.
    tabsByTask.set(props.taskId, fresh)
    return fresh
  }

  const [state, setState] = createSignal<TabsState>(initState())
  const update = (next: TabsState): void => {
    tabsByTask.set(props.taskId, next)
    setState(next)
    // Tab metadata survives restarts via kv/state.json (issue #22); the
    // rehydrate above filters what shouldn't come back.
    kv.set(persistKey, next)
  }

  /** Engine-tab argv: the tab's pinned session id rides the base command.
   *  Three cases: a LIVE PTY ignores `command` entirely (registry reuse);
   *  a tab that already ran but whose PTY is gone (app restart —
   *  `releaseAll` killed everything) RESUMES its conversation; a
   *  never-spawned tab opens a fresh session under its pinned id — the
   *  same `--session-id` append `withClaudeSessionId` produced. */
  const engineTabCommand = (tab: EngineTab): readonly string[] => {
    const base = tab.vendor ? interactiveEngineCommand(tab.vendor, props.modelEffort) : props.command
    if (!tab.sessionId) return base
    const live = getDefaultPtyRegistry().has(tabPtyKey(props.taskId, tab.id))
    if (tab.spawned && !live) return [...base, "--resume", tab.sessionId]
    return [...base, "--session-id", tab.sessionId]
  }

  // Mark the mounted engine tab as spawned (its PTY acquires right after
  // mount) — the flag flips the restart path above from fresh-session to
  // resume. Self-terminating: once set, the guard stops further writes.
  createEffect(() => {
    const tab = active()
    if (tab?.kind === "engine" && !tab.spawned) update(markTabSpawned(state(), tab.id))
  })

  props.onEditorTabReady?.((command, label) => update(openEditorTab(state(), command, label)))

  const active = () => state().tabs.find((tab) => tab.id === state().activeId) ?? state().tabs[0]

  /* --------- auto-naming (tmux runChatTabNamingPass, logic layer) ---------
   * Every NAMING_POLL_MS, derive a title from each unnamed engine tab's own
   * transcript (`deriveTitleFromSessionId` — the same tmux-free deriver the
   * tmux pass used). Self-limiting: once autoTitle lands (or the user
   * F2-renames) the tab leaves the candidate set; a tab with no prompt yet
   * derives "" and retries next tick. */
  let namingBusy = false
  const namingTimer = setInterval(() => {
    if (namingBusy) return
    const candidates = state().tabs.filter(
      (tab): tab is EngineTab => tab.kind === "engine" && !!tab.sessionId && !tab.title && !tab.autoTitle,
    )
    if (candidates.length === 0) return
    namingBusy = true
    void (async () => {
      try {
        for (const tab of candidates) {
          if (!tab.sessionId) continue
          const title = await deriveTitleFromSessionId(tab.vendor ?? props.vendor, tab.sessionId)
          if (title) update(setTabAutoTitle(state(), tab.id, title))
        }
      } finally {
        namingBusy = false
      }
    })()
  }, NAMING_POLL_MS)
  onCleanup(() => clearInterval(namingTimer))

  /* --------- per-tab turn state (tmux @kobe_tab_state, logic layer) -------
   * The SAME `startTurnStatusPoll` loop the Ops pane runs, with PTY IO in
   * place of tmux capture-pane — the in-process snapshot IS the pane
   * capture. Shared mode when the host passes the daemon's
   * transcript.activity slice (`sharedActivity`), local fixed-cadence
   * fallback otherwise. Polls attach lazily (a tab's PTY spawns after
   * its Terminal mounts and measures), retried on a slow tick. */
  const [turnStates, setTurnStates] = createSignal<ReadonlyMap<string, ChatTabTurnState>>(new Map())
  const turnPolls = new Map<string, () => void>()
  const [pollTick, setPollTick] = createSignal(0)
  const pollAttachTimer = setInterval(() => setPollTick((n) => n + 1), TURN_POLL_ATTACH_MS)
  onCleanup(() => clearInterval(pollAttachTimer))
  createEffect(() => {
    pollTick()
    const reg = getDefaultPtyRegistry()
    const engineIds = new Set<string>()
    for (const tab of state().tabs) {
      if (tab.kind !== "engine") continue
      engineIds.add(tab.id)
      if (turnPolls.has(tab.id)) continue
      const key = tabPtyKey(props.taskId, tab.id)
      // Attach only once the PTY exists so the loop's prime() hashes a
      // real first capture (the Ops pane's prime-before-poll contract).
      if (!reg.has(key)) continue
      const tabId = tab.id
      const detector = engineEntry(tab.vendor ?? props.vendor).createTurnDetector()
      const dispose = startTurnStatusPoll(
        {
          worktree: props.worktree,
          detector,
          // Shared mode (issue #24): the daemon's transcript.activity push
          // supplies completion reads + drives the adaptive capture
          // cadence; null (no daemon data) falls back to fixed-cadence
          // local polling — the Ops pane's exact contract.
          usingShared: () => (props.sharedActivity?.() ?? null) !== null,
          sharedEntry: () => props.sharedActivity?.() ?? null,
        },
        {
          sessionAttached: async () => true,
          capturePane: async () => {
            const pty = getDefaultPtyRegistry().get(key)
            if (!pty) throw new Error("pty gone")
            return pty
              .capture()
              .map((row) => row.map((chunk) => chunk.text).join(""))
              .join("\n")
          },
          setTurnState: async (turn) => {
            setTurnStates((prev) => new Map(prev).set(tabId, turn))
            // Background completion rides the standard notification path
            // (unread + toast) — the PTY-world version of noticing a ✓
            // land on an unfocused tmux window.
            if (turn === "done" && state().activeId !== tabId) {
              const current = state().tabs.find((t) => t.id === tabId)
              if (current) notif.notify({ kind: "done", taskId: props.taskId, tabId, title: tabTitle(current) })
            }
          },
        },
      )
      turnPolls.set(tabId, dispose)
    }
    // Tabs that closed or degraded to a shell stop polling.
    for (const [id, dispose] of turnPolls) {
      if (engineIds.has(id)) continue
      dispose()
      turnPolls.delete(id)
      setTurnStates((prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
    }
  })
  onCleanup(() => {
    for (const dispose of turnPolls.values()) dispose()
  })

  // Visiting a tab clears its unread mark (toast already auto-dismisses).
  createEffect(
    on(
      () => state().activeId,
      (activeId) => notif.markRead(props.taskId, activeId),
    ),
  )

  /** Nudge Terminal to re-acquire under the CURRENTLY visible tab's key —
   *  see the `resetToken` doc on `Terminal.tsx`. Only the shell-degrade
   *  flow needs this: same tab id before/after, so a plain taskId change
   *  never fires. Ordinary tab switches don't touch it — `taskId`/`command`
   *  below already change on every switch, and Terminal's own cwd/taskId
   *  effect re-acquires + re-primes in place without a remount (a forced
   *  remount per switch was the fast-cycling "flashes back to the
   *  previous tab" bug this replaces). */
  const [resetToken, setResetToken] = createSignal(0)

  /** Auto-close (issue #16): a command tab (editor tab, or an engine
   *  tab already degraded to a shell — kind "command" either way) closes
   *  itself when that process exits and releases its PTY — same cleanup
   *  `chat.tab.close` performs for a manual ctrl+w, just self-triggered.
   *  The last tab refuses to close (core guard) and keeps the exit
   *  banner + F5 recovery path instead. */
  function closeExitedTab(id: string): void {
    const { state: next, closedId } = closeTab(state(), id)
    if (closedId) {
      // Split leaves first (their keys namespace under the tab key),
      // then the tab's own PTY.
      releaseSplitLeaves(tabPtyKey(props.taskId, closedId))
      getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
    }
    update(next)
  }

  /** Vendor exit is an allowed case (owner decision 2026-07-06): an engine
   *  tab whose CLI exits degrades into a plain shell at the same worktree
   *  instead of freezing behind the dead-shell banner. */
  function degradeToShell(id: string): void {
    const tab = state().tabs.find((t) => t.id === id)
    if (tab?.kind !== "engine") return
    const wasActive = id === state().activeId
    update(tabToShell(state(), id, [defaultShell()]))
    getDefaultPtyRegistry().release(tabPtyKey(props.taskId, id))
    // The degraded tab's id (hence pty key) is unchanged, so if it's the
    // one on screen Terminal is still holding the now-dead handle — force
    // it to notice. A backgrounded tab needs no nudge: switching TO it
    // later is itself a taskId change, which re-acquires naturally.
    if (wasActive) setResetToken((n) => n + 1)
  }

  /** The active tab's argv, narrowed by kind — read fresh on every switch
   *  (Solid's JSX-prop getters keep `command` below reactive to `active()`
   *  without a remount). */
  const activeCommand = (): readonly string[] => {
    const tab = active()
    return tab.kind === "command" ? tab.command : engineTabCommand(tab)
  }

  /** The active tab's exit behavior, resolved at invocation time (not
   *  capture time) — always reflects whichever tab is actually mounted
   *  when its process exits. */
  function handleActiveExit(): void {
    const tab = active()
    if (tab.kind === "command") closeExitedTab(tab.id)
    else degradeToShell(tab.id)
  }

  const requestRename = (): void => {
    const tab = active()
    if (!tab) return
    void RenameTaskDialog.show(dialog, tabTitle(tab), {
      dialogTitle: t("terminal.tab.renameTitle"),
      fieldLabel: t("terminal.tab.renameField"),
      submitLabel: t("terminal.tab.renameSubmit"),
      allowEmpty: true,
    }).then((title) => {
      if (title === undefined) return
      update(renameActiveTab(state(), title))
    })
  }

  const requestChooseEngine = (): void => {
    void (async () => {
      const available = await availableEngineIds()
      const picked = await EnginePickerDialog.show(dialog, available, props.vendor)
      if (picked === undefined) return
      update(pinSession(addTab(state(), picked), picked))
      props.onChooseEngine?.(picked)
      // Also the project's last-active engine (never the global default) —
      // the second half of tmux's rememberSessionVendor dual persistence.
      try {
        setRepoLastActiveVendor(resolveMainRepoRoot(props.worktree), picked)
      } catch {
        // Best-effort: a stale worktree path must not block the new tab.
      }
    })()
  }

  useBindings(() => ({
    enabled: props.focused(),
    bindings: bindByIds({
      "chat.tab.new": () => update(pinSession(addTab(state()), undefined)),
      "chat.tab.chooseEngine": requestChooseEngine,
      "chat.tab.close": () => {
        const { state: next, closedId } = closeActiveTab(state())
        if (!closedId) {
          // tmux surfaced `display-message 'Cannot close the only ChatTab'`;
          // the PTY-world equivalent is an error toast (always shown).
          notif.notify({
            kind: "error",
            taskId: props.taskId,
            tabId: state().activeId,
            title: t("terminal.tab.cannotCloseLast"),
          })
          return
        }
        update(next)
        // Kill the closed tab's PTYs — split leaves first (their keys
        // namespace under the tab key), then the tab's own. Nobody else
        // owns this teardown (releaseWhere only fires on task archive,
        // releaseAll on app exit), so dropping closedId here leaked the
        // engine process until archive — the ctrl+w leak class of #14.
        releaseSplitLeaves(tabPtyKey(props.taskId, closedId))
        getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
      },
      "chat.tab.rename": requestRename,
      "chat.tab.cycle-next": () => update(cycleTab(state(), 1)),
      "chat.tab.cycle-prev": () => update(cycleTab(state(), -1)),
    }),
  }))

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Tab strip — flush to the pane edge, dense, hidden for one tab. */}
      <Show when={state().tabs.length > 1}>
        <box flexDirection="row" gap={1} flexShrink={0} paddingLeft={1} backgroundColor={theme.backgroundElement}>
          <For each={state().tabs}>
            {(tab) => {
              const turn = () => turnStates().get(tab.id) ?? "idle"
              const turnColor = () =>
                turn() === "running"
                  ? theme.focusAccent
                  : turn() === "done"
                    ? theme.success
                    : turn() === "error"
                      ? theme.error
                      : theme.textMuted
              return (
                <box flexDirection="row" gap={0} onMouseUp={() => update(selectTab(state(), tab.id))}>
                  {/* Turn chip — tmux CHAT_TAB_STATUS_FORMAT's ●/✓/!/?/○,
                      engine tabs only (a command tab has no turns). */}
                  <Show when={tab.kind === "engine"}>
                    <text fg={turnColor()} wrapMode="none">
                      {`${TURN_GLYPHS[turn()]} `}
                    </text>
                  </Show>
                  <text
                    fg={tab.id === state().activeId ? theme.focusAccent : theme.textMuted}
                    attributes={tab.id === state().activeId ? TextAttributes.BOLD : undefined}
                    wrapMode="none"
                  >
                    {tabTitle(tab)}
                  </text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
      {/* One long-lived tab body, never remounted on an ordinary tab
          switch — only its `tabKey`/`command` change. TerminalSplit
          renders a single persistent Terminal while the tab is unsplit
          (its cwd/taskId effect re-acquires + re-primes in place; see
          the `resetToken` doc above for the one case that needs a
          nudge) and swaps to the split-tree renderer once ctrl+\ /
          ctrl+= create leaves. */}
      <TerminalSplit
        tabKey={tabPtyKey(props.taskId, active().id)}
        cwd={() => props.worktree}
        command={activeCommand()}
        onExit={handleActiveExit}
        resetToken={resetToken}
        focused={props.focused}
      />
    </box>
  )
}
