/**
 * Workspace terminal tabs (issue #16) — the PTY-world chattab. A strip of
 * engine-terminal tabs above the embedded Terminal pane; every tab runs
 * an interactive engine command in its own PTY (registry key
 * `${taskId}::${tabId}`), so ctrl+t gives a parallel session in the same
 * worktree exactly like the tmux chattab did with windows. Plain ctrl+t
 * opens the user's preferred engine (`resolvePreferredVendor`: repo
 * lastActiveVendor → Settings global default → claude); ctrl+e prompts
 * for one instead (`chat.tab.chooseEngine`, tmux's `ctrl+shift+t`
 * equivalent), pins it to just that tab via `TerminalTab.vendor`, and
 * records the pick as the project's new default.
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
import { deriveTitleFromSessionId } from "@/monitor/auto-title"
import { resolveMainRepoRoot } from "@/state/repos"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "@/state/vendor-prefs"
import type { VendorId } from "@/types/vendor"
import { Show, createEffect, createSignal, on, onCleanup } from "solid-js"
import { EnginePickerDialog } from "../component/engine-picker-dialog/index"
import { RenameTaskDialog } from "../component/rename-task-dialog/index"
import { bindByIds } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { t } from "../i18n"
import { useBindings } from "../lib/keymap"
import type { Terminal } from "../panes/terminal/Terminal"
import { defaultShell } from "../panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../panes/terminal/registry"
import { useDialog } from "../ui/dialog"
import { TerminalSplit, releaseSplitLeaves } from "./TerminalSplit"
import { TabStrip, tabTitle } from "./tab-strip"
import {
  type EngineTab,
  type TabsState,
  addTab,
  closeActiveTab,
  closeTab,
  cycleTab,
  initialTabs,
  openEditorTab,
  rehydrateTabs,
  renameActiveTab,
  selectTab,
  setTabAutoTitle,
  setTabSessionId,
  setTabSpawned,
  setTabSplit,
  tabPtyKey,
  tabToShell,
} from "./terminal-tabs-core"
import { createTurnPolls } from "./turn-polls"

/** Per-task tab state, preserved across task switches for the process. */
const tabsByTask = new Map<string, TabsState>()

/** Cadence of the tab auto-naming pass (tmux ran its pass on the monitor tick). */
const NAMING_POLL_MS = 5000

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
   * Hands the parent an imperative "paste this into the active engine tab
   * and submit" function (same sibling-reach rationale as
   * `onEditorTabReady`). Powers the FileTree corner Create-PR action —
   * the PTY-world twin of the Ops pane's tmux `send-keys` + Enter.
   */
  onEngineSendReady?: (send: (text: string) => void) => void
  /**
   * This worktree's slice of the daemon's `transcript.activity` push
   * (issue #24) — feeds the turn-status loops' shared mode (adaptive
   * capture cadence + push-driven completion reads). Omitted/null =
   * fallback mode (fixed-cadence local polling), same contract as the
   * Ops pane.
   */
  sharedActivity?: () => TranscriptActivity | null
  focused: () => boolean
  /** Ask the host to focus the workspace pane (terminal click). */
  onRequestFocus?: () => void
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

  // Flips true when initState rehydrated from disk — those tabs' `spawned`
  // flags are up to 5s stale (the naming tick's cadence) and must be
  // re-verified against the real transcripts before anything spawns.
  let rehydratedFromDisk = false
  const initState = (): TabsState => {
    const existing = tabsByTask.get(props.taskId)
    if (existing) return existing
    // Restart survival (issue #22): rehydrate the persisted tab snapshot
    // (titles/ordinals/sessionIds; engine tabs resume their conversation,
    // command tabs — degraded shells, dead editors — respawn as shells)
    // before falling back to a fresh single tab.
    const saved = kv.get(persistKey, null) as TabsState | null
    const fromDisk = saved && Array.isArray(saved.tabs) ? rehydrateTabs(saved, [defaultShell()]) : null
    rehydratedFromDisk = fromDisk !== null
    const fresh = fromDisk ?? pinSession(initialTabs(), undefined)
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

  /* --------- restart resume verification (issue #22) --------------------
   * `--resume <id>` errors ("no conversation found") when the session has
   * no transcript — claude writes NOTHING until the first message — and
   * `--session-id <id>` errors when one already exists. The only correct
   * predicate is the transcript itself, so on a disk rehydrate we hold the
   * spawn (the Show gate below) and set each tab's `spawned` from a real
   * history read before the first PTY starts. Millisecond-scale reads;
   * failures degrade to fresh-session (never the not-found path). */
  const [hydrating, setHydrating] = createSignal(rehydratedFromDisk)
  if (rehydratedFromDisk) {
    void (async () => {
      try {
        await Promise.all(
          state().tabs.map(async (tab) => {
            if (tab.kind !== "engine" || !tab.sessionId) return
            let exists = false
            try {
              exists = (await engineEntry(tab.vendor ?? props.vendor).history.readHistory(tab.sessionId)).length > 0
            } catch {
              /* unreadable store → treat as absent (fresh session) */
            }
            update(setTabSpawned(state(), tab.id, exists))
          }),
        )
      } finally {
        setHydrating(false)
      }
    })()
  }

  props.onEditorTabReady?.((command, label) => update(openEditorTab(state(), command, label)))

  props.onEngineSendReady?.((text) => {
    // Active tab when it's an engine; else the first engine tab (the PR
    // prompt must reach a conversation, never a degraded shell/editor).
    const activeTab = state().tabs.find((tab) => tab.id === state().activeId)
    const target = activeTab?.kind === "engine" ? activeTab : state().tabs.find((tab) => tab.kind === "engine")
    if (!target) return
    const pty = getDefaultPtyRegistry().get(tabPtyKey(props.taskId, target.id))
    if (!pty || pty.killed) return
    pty.paste(text)
    pty.write("\r")
  })

  const active = () => state().tabs.find((tab) => tab.id === state().activeId) ?? state().tabs[0]

  /* --------- auto-naming + existence tracking (tmux naming pass) ---------
   * Every NAMING_POLL_MS, derive a title from each engine tab's own
   * transcript (`deriveTitleFromSessionId` — the same tmux-free deriver the
   * tmux pass used). A non-empty derivation is DUAL-purpose: it proves the
   * conversation exists on disk (→ `spawned`, the restart resume
   * predicate) and supplies the display autoTitle. Self-limiting: once
   * spawned + named (or F2-renamed), the tab leaves the candidate set; a
   * tab with no prompt yet derives "" and retries next tick. */
  let namingBusy = false
  const namingTimer = setInterval(() => {
    if (namingBusy) return
    const candidates = state().tabs.filter(
      (tab): tab is EngineTab =>
        tab.kind === "engine" && !!tab.sessionId && (!tab.spawned || (!tab.title && !tab.autoTitle)),
    )
    if (candidates.length === 0) return
    namingBusy = true
    void (async () => {
      try {
        for (const tab of candidates) {
          if (!tab.sessionId) continue
          const title = await deriveTitleFromSessionId(tab.vendor ?? props.vendor, tab.sessionId)
          if (!title) continue
          let next = setTabSpawned(state(), tab.id, true)
          if (!tab.title && !tab.autoTitle) next = setTabAutoTitle(next, tab.id, title)
          update(next)
        }
      } finally {
        namingBusy = false
      }
    })()
  }, NAMING_POLL_MS)
  onCleanup(() => clearInterval(namingTimer))

  /* --------- per-tab turn state (tmux @kobe_tab_state, logic layer) -------
   * Extracted to `turn-polls.ts` — the Ops-pane poll loop with PTY IO,
   * shared/local cadence per the sharedActivity contract. */
  const { turnStates, liveTitles } = createTurnPolls({
    taskId: props.taskId,
    worktree: props.worktree,
    vendor: () => props.vendor,
    state,
    sharedActivity: props.sharedActivity,
    onBackgroundDone: (tabId) => {
      const current = state().tabs.find((t) => t.id === tabId)
      if (current) notif.notify({ kind: "done", taskId: props.taskId, tabId, title: tabTitle(current, props.vendor) })
    },
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
    const closing = state().tabs.find((t) => t.id === id)
    const { state: next, closedId } = closeTab(state(), id)
    if (closedId) {
      // Split leaves first (their keys namespace under the tab key),
      // then the tab's own PTY. The tree comes off the closing tab (it
      // lives on the persisted tab now, not a module map).
      releaseSplitLeaves(tabPtyKey(props.taskId, closedId), closing?.splitTree ?? null)
      getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
    }
    update(next)
  }

  /** Vendor exit is an allowed case: an engine
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
    void RenameTaskDialog.show(dialog, tabTitle(tab, props.vendor, liveTitles().get(tab.id)), {
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

  /** What a plain ctrl+t tab should run: the
   *  full preference chain — repo lastActiveVendor (ctrl+e / dialog picks
   *  write it) → Settings global default → claude. Always CONCRETE: the
   *  tab pins the vendor it actually spawns. The old "inherit" mode
   *  (undefined when equal to the task engine) let a later task-vendor
   *  switch relabel and re-target every earlier tab — including resuming
   *  a claude session with the codex CLI after restart. A tab's engine is
   *  whatever it was born with; only the TASK's default moves. */
  const preferredTabVendor = (): VendorId => {
    try {
      return resolvePreferredVendor(resolveMainRepoRoot(props.worktree))
    } catch {
      return props.vendor
    }
  }

  useBindings(() => ({
    enabled: props.focused(),
    bindings: bindByIds({
      "chat.tab.new": () => {
        const preferred = preferredTabVendor()
        update(pinSession(addTab(state(), preferred), preferred))
      },
      "chat.tab.chooseEngine": requestChooseEngine,
      "chat.tab.close": () => {
        const closing = state().tabs.find((t) => t.id === state().activeId)
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
        releaseSplitLeaves(tabPtyKey(props.taskId, closedId), closing?.splitTree ?? null)
        getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
      },
      "chat.tab.rename": requestRename,
      "chat.tab.cycle-next": () => update(cycleTab(state(), 1)),
      "chat.tab.cycle-prev": () => update(cycleTab(state(), -1)),
    }),
  }))

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Tab strip — flush to the pane edge, dense, hidden for one tab.
          View + turn-complete pulse live in tab-strip.tsx. */}
      <Show when={state().tabs.length > 1}>
        <TabStrip
          tabs={() => state().tabs}
          activeId={() => state().activeId}
          turnStates={turnStates}
          onSelect={(tabId) => update(selectTab(state(), tabId))}
          vendor={() => props.vendor}
          liveTitles={liveTitles}
        />
      </Show>
      {/* One long-lived tab body, never remounted on an ordinary tab
          switch — only its `tabKey`/`command` change. TerminalSplit
          renders a single persistent Terminal while the tab is unsplit
          (its cwd/taskId effect re-acquires + re-primes in place; see
          the `resetToken` doc above for the one case that needs a
          nudge) and swaps to the split-tree renderer once ctrl+\ /
          ctrl+= create leaves. */}
      {/* Spawn gate: while restart verification runs (millisecond-scale
          transcript reads), nothing may spawn — the resume/fresh flag
          decision must land first, or the wrong claude flag errors and
          degrades the tab. */}
      <Show
        when={!hydrating()}
        fallback={
          <box flexGrow={1} paddingLeft={1} paddingTop={1}>
            <text fg={theme.textMuted}>{t("terminal.restoring")}</text>
          </box>
        }
      >
        <TerminalSplit
          tabKey={tabPtyKey(props.taskId, active().id)}
          cwd={() => props.worktree}
          command={activeCommand()}
          splitTree={() => active().splitTree ?? null}
          onSplitChange={(next) => update(setTabSplit(state(), active().id, next))}
          onExit={handleActiveExit}
          resetToken={resetToken}
          focused={props.focused}
          onRequestFocus={props.onRequestFocus}
          // Engine leaf name = the tab's first-prompt title (title ?? auto),
          // NOT the "group N" fallback — before the first prompt the split
          // shows the vendor basename ("claude") instead of "group N".
          engineTitle={() => active().title ?? active().autoTitle ?? null}
        />
      </Show>
    </box>
  )
}
