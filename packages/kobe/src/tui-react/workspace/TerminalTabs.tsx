/** @jsxImportSource @opentui/react */
/**
 * Workspace terminal tabs (issue #16) — React port of `tui/workspace/
 * TerminalTabs.tsx` (issue #16 React migration). The PTY-world chattab: a
 * strip of engine-terminal tabs above the embedded Terminal pane; every tab
 * runs an interactive engine command in its own PTY (registry key
 * `${taskId}::${tabId}`), so ctrl+t gives a parallel session in the same
 * worktree exactly like the tmux chattab did with windows. Plain ctrl+t
 * opens the user's preferred engine (`resolvePreferredVendor`); ctrl+e
 * prompts for one instead (`chat.tab.chooseEngine`), pins it to just that
 * tab via `TerminalTab.vendor`, and records the pick as the project's new
 * default.
 *
 * Chords reuse the canonical chattab binding ids: ctrl+t new · ctrl+e
 * new-with-engine · ctrl+w close (last tab refuses) · F2 rename · ctrl+]/[
 * cycle. Per-task tab state lives in a module-level map so switching tasks
 * and back preserves each task's tabs (their PTYs already survive via the
 * registry's acquire-reuse) — same module map as the Solid original;
 * module-level state is framework-agnostic.
 *
 * Solid→React deltas (the load-bearing one): everything the Solid
 * component reads via the live `state()` accessor becomes a `stateRef`
 * that `update()` refreshes SYNCHRONOUSLY on every write. This matters
 * for the two places multiple `update()` calls land within one JS tick
 * without an intervening render — the restart-hydration `Promise.all` and
 * the naming-poll's per-candidate loop — where a plain destructured
 * `state` variable would go stale mid-loop and a later `update()` would
 * clobber an earlier one's change. `propsRef` gives the same freshness
 * to props read inside the two mount-only, forever-lived effects (the
 * naming-poll interval, the hydration verification) — both effects run
 * ONCE (`useEffect(..., [])`), so anything they read must come through a
 * ref, not a captured render-time value. Everywhere else (event handlers,
 * `useBindings` configs, JSX) reads the plain `state`/`props` directly —
 * those are recreated fresh every render, same guarantee Solid's
 * accessors gave for free. `onEditorTabReady`/`onEngineSendReady` hand
 * their callback to the parent once per mount (a `useEffect(..., [])`)
 * instead of Solid's once-per-setup call — remounting on task/worktree
 * switch (the parent's `key`-ed Show/keyed render) re-fires it exactly
 * like the Solid original's re-setup.
 */

import type { TranscriptActivity } from "@/client/remote-orchestrator"
import { availableEngineIds } from "@/engine/account-detect"
import { interactiveEngineCommand, withClaudeSessionId } from "@/engine/interactive-command"
import { resolveMainRepoRoot } from "@/state/repos"
import { resolvePreferredVendor, setRepoLastActiveVendor } from "@/state/vendor-prefs"
import type { VendorId } from "@/types/vendor"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { defaultShell } from "../../tui/panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import { waitAndDeliverInitialPrompt } from "../../tui/workspace/quick-fork-delivery"
import {
  type EngineTab,
  type TabsState,
  addTab,
  closeActiveTab,
  closeTab,
  cycleTab,
  engineTabArgv,
  findEditorTab,
  initialTabs,
  isTabSplit,
  openCommandTab,
  openEditorTab,
  rehydrateTabs,
  renameActiveTab,
  selectTab,
  setTabSessionId,
  setTabSplit,
  tabExitAction,
  tabPtyKey,
  tabToShell,
} from "../../tui/workspace/terminal-tabs-core"
import { EnginePickerDialog } from "../component/engine-picker-dialog"
import { QuickTaskComposer, type QuickTaskResult } from "../component/quick-task-composer"
import { RenameTaskDialog } from "../component/rename-task-dialog"
import { bindByIds } from "../context/keybindings"
import { useKV } from "../context/kv"
import { useNotifications } from "../context/notifications"
import { useTheme } from "../context/theme"
import { useT } from "../i18n"
import { useBindings } from "../lib/keymap"
import { useDialog } from "../ui/dialog"
import { TerminalSplit, releaseSplitLeaves } from "./TerminalSplit"
import { quickForkComposerOptions, quickForkDefaultVendor } from "./quick-fork"
import { TabStrip, tabTitle } from "./tab-strip"
import { useTabHydration, useTabNaming } from "./use-tab-lifecycle"
import { useTurnPolls } from "./use-turn-polls"

/** Per-task tab state, preserved across task switches for the process. */
const tabsByTask = new Map<string, TabsState>()

export interface TerminalTabsProps {
  taskId: string
  worktree: string
  command: readonly string[]
  /** Task's current engine + effort — used to build a per-tab command when
   *  a tab pins its own vendor via `chooseEngine`. */
  vendor: VendorId
  modelEffort?: string
  /** Best-effort: persist the picked vendor as the task's new default. */
  onChooseEngine?: (vendor: VendorId) => void
  /** Hands the parent an imperative "open this file in the editor tab"
   *  function, once per mount (see file header). */
  onEditorTabReady?: (open: (command: readonly string[], label: string) => void) => void
  /** Hands the parent an imperative "paste this into the active engine tab
   *  and submit" function, once per mount (see file header). */
  onEngineSendReady?: (send: (text: string) => void) => void
  /** Quick-fork (issue #17): the composer submitted — parent creates the
   *  child task (in `repo`, the source task's main repo root) and jumps in. */
  onQuickFork?: (repo: string, result: QuickTaskResult) => void
  /** Quick-fork phase 2: a prompt to auto-deliver into this task's first
   *  engine tab once its PTY produces its first output chunk. Consumed
   *  ONCE on mount (see the delivery effect below) — a later prop change
   *  does nothing, matching `onEditorTabReady`/`onEngineSendReady`'s
   *  mount-once handoff shape. */
  initialPrompt?: string
  /** This worktree's slice of the daemon's `transcript.activity` push. */
  sharedActivity?: TranscriptActivity | null
  focused: boolean
  /** Ask the host to focus the workspace pane (terminal click). */
  onRequestFocus?: () => void
}

export function TerminalTabs(props: TerminalTabsProps): ReactNode {
  const { theme } = useTheme()
  const dialog = useDialog()
  const notif = useNotifications()
  const kv = useKV()
  const t = useT()
  const persistKey = `terminalTabs.${props.taskId}`

  // Latest-render mirror — read inside the two mount-only forever-lived
  // effects below (see file header).
  const propsRef = useRef(props)
  propsRef.current = props

  /** Pin a fresh engine-session id on the just-created active engine tab —
   *  the tmux `@kobe_session_id` stash. */
  const pinSession = (s: TabsState, vendor: VendorId | undefined): TabsState => {
    const base = vendor ? interactiveEngineCommand(vendor, props.modelEffort) : props.command
    const { sessionId } = withClaudeSessionId(base, vendor ?? props.vendor)
    return setTabSessionId(s, s.activeId, sessionId)
  }

  // Flips true when initState rehydrated from disk — those tabs' `spawned`
  // flags are up to 5s stale and must be re-verified against the real
  // transcripts before anything spawns. A ref (not a plain render-scope
  // `let`) so it survives past the one `useState` lazy-init call.
  const rehydratedRef = useRef(false)
  const initState = (): TabsState => {
    const existing = tabsByTask.get(props.taskId)
    if (existing) return existing
    // Restart survival (issue #22): rehydrate the persisted tab snapshot
    // before falling back to a fresh single tab.
    const saved = kv.get(persistKey, null) as TabsState | null
    const fromDisk = saved && Array.isArray(saved.tabs) ? rehydrateTabs(saved, [defaultShell()]) : null
    rehydratedRef.current = fromDisk !== null
    const fresh = fromDisk ?? pinSession(initialTabs(), undefined)
    tabsByTask.set(props.taskId, fresh)
    return fresh
  }

  const [state, setState] = useState<TabsState>(initState)
  const stateRef = useRef(state)
  stateRef.current = state

  const update = (next: TabsState): void => {
    tabsByTask.set(propsRef.current.taskId, next)
    stateRef.current = next
    setState(next)
    kv.set(persistKey, next)
  }

  /** Engine-tab argv: the tab's pinned session id rides the base command
   *  (resume-vs-pin decision is pure — `engineTabArgv`). */
  const engineTabCommand = (tab: EngineTab): readonly string[] => {
    const base = tab.vendor ? interactiveEngineCommand(tab.vendor, props.modelEffort) : props.command
    return engineTabArgv(tab, base, getDefaultPtyRegistry().has(tabPtyKey(props.taskId, tab.id)))
  }
  // Latest-render mirror for the mount-once engine-send closure below —
  // same freshness convention as propsRef/stateRef (file header).
  const engineTabCommandRef = useRef(engineTabCommand)
  engineTabCommandRef.current = engineTabCommand

  /** Nudge Terminal to re-acquire under the CURRENTLY visible tab's key —
   *  see the `resetToken` doc on `Terminal.tsx`. */
  const [resetToken, setResetToken] = useState(0)

  /* --------- restart resume verification (issue #22) — mount-only ------- */
  const hydrating = useTabHydration(rehydratedRef.current, { stateRef, propsRef, update })

  // Hand the parent the editor-tab / engine-send imperative handles once
  // per mount — remounting on task/worktree switch re-fires it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once handoff; the callback reads propsRef/stateRef for freshness.
  useEffect(() => {
    propsRef.current.onEditorTabReady?.((command, label) => {
      const current = stateRef.current
      const existing = findEditorTab(current)
      if (existing) {
        const key = tabPtyKey(propsRef.current.taskId, existing.id)
        releaseSplitLeaves(key, existing.splitTree ?? null)
        getDefaultPtyRegistry().release(key)
      }
      update(openEditorTab(current, command, label))
      if (existing?.id === current.activeId) setResetToken((n) => n + 1)
    })
  }, [])
  useEffect(() => {
    propsRef.current.onEngineSendReady?.((text) => {
      // Active tab when it's an engine; else the first engine tab.
      const activeTab = stateRef.current.tabs.find((tab) => tab.id === stateRef.current.activeId)
      const target = activeTab?.kind === "engine" ? activeTab : stateRef.current.tabs.find((t) => t.kind === "engine")
      if (!target) return
      const reg = getDefaultPtyRegistry()
      const key = tabPtyKey(propsRef.current.taskId, target.id)
      let pty = reg.get(key)
      if (!pty && target.kind === "engine") {
        // Parked background tab (issue #28): the host still runs the
        // session — re-acquire reattaches + replays, then the paste lands.
        // Default geometry until the tab is next mounted; the engine
        // rewraps on the real resize like any terminal.
        try {
          pty = reg.acquire(key, propsRef.current.worktree, { command: engineTabCommandRef.current(target) })
        } catch {
          return
        }
      }
      if (!pty || pty.killed) return
      pty.paste(text)
      pty.write("\r")
    })
  }, [])

  // Quick-fork phase 2: deliver `initialPrompt` into the first engine tab's
  // PTY once it produces its first output chunk (the engine banner) — see
  // `quick-fork-delivery.ts` for the readiness contract. Mount-once (like
  // the two handoffs above); a ref guard covers React StrictMode's double
  // effect-fire. The 5s-timeout fallback surfaces an error toast instead of
  // silently dropping the prompt.
  const initialPromptSentRef = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once delivery; reads propsRef/stateRef for freshness.
  useEffect(() => {
    const prompt = propsRef.current.initialPrompt
    if (!prompt || initialPromptSentRef.current) return
    initialPromptSentRef.current = true
    const controller = new AbortController()
    const target = stateRef.current.tabs.find((tab) => tab.kind === "engine")
    if (!target) return
    void waitAndDeliverInitialPrompt(
      () => getDefaultPtyRegistry().get(tabPtyKey(propsRef.current.taskId, target.id)),
      prompt,
      undefined,
      controller.signal,
    ).then((result) => {
      if (result.delivered) return
      notif.notify({
        kind: "error",
        taskId: propsRef.current.taskId,
        tabId: target.id,
        title: t("terminal.quickFork.deliveryFailed"),
      })
    })
    return () => controller.abort()
  }, [])

  const active = state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]

  /* --------- auto-naming + existence tracking (tmux naming pass), mount-only --- */
  useTabNaming({ stateRef, propsRef, update })

  /* --------- per-tab turn state --------- */
  const { turnStates, liveTitles, turnVendors } = useTurnPolls({
    taskId: props.taskId,
    worktree: props.worktree,
    vendor: props.vendor,
    state,
    sharedActivity: props.sharedActivity,
    onBackgroundDone: (tabId) => {
      const current = state.tabs.find((tb) => tb.id === tabId)
      if (current) notif.notify({ kind: "done", taskId: props.taskId, tabId, title: tabTitle(current, props.vendor) })
    },
  })

  // Visiting a tab clears its unread mark (toast already auto-dismisses).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires only on a real activeId transition, matching the Solid `on(...)` guard; `notif`/`taskId` are stable for this component's lifetime.
  useEffect(() => {
    notif.markRead(props.taskId, state.activeId)
  }, [state.activeId])

  /** Auto-close (issue #16): a command tab closes itself when that process
   *  exits and releases its PTY. */
  function closeExitedTab(id: string): void {
    const closing = state.tabs.find((tb) => tb.id === id)
    const { state: next, closedId } = closeTab(state, id)
    if (closedId) {
      releaseSplitLeaves(tabPtyKey(props.taskId, closedId), closing?.splitTree ?? null)
      getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
    }
    update(next)
  }

  /** Vendor exit is an allowed case: an engine tab whose CLI exits degrades
   *  into a plain shell at the same worktree. */
  function degradeToShell(id: string): void {
    const tab = state.tabs.find((tb) => tb.id === id)
    if (tab?.kind !== "engine") return
    const wasActive = id === state.activeId
    update(tabToShell(state, id, [defaultShell()]))
    getDefaultPtyRegistry().release(tabPtyKey(props.taskId, id))
    if (wasActive) setResetToken((n) => n + 1)
  }

  const activeCommand = (): readonly string[] => (active.kind === "command" ? active.command : engineTabCommand(active))

  /** Engine tabs whose dead-on-attach resume was already attempted — one
   *  shot per tab, so a `--resume` that itself dies degrades normally
   *  instead of respawning forever. */
  const resumeTriedRef = useRef(new Set<string>())

  function handleActiveExit(info?: { deadOnAttach?: boolean }): void {
    // Policy is pure (`tabExitAction`): command tabs close; a corpse found
    // on reattach (host restart, park-sweep window, machine reboot) gets
    // ONE resume — releasing the dead handle makes `engineTabCommand`
    // build `--resume <sessionId>` on the re-acquire (`spawned && !live`),
    // the restart-survival path; everything else degrades to a shell.
    const action = tabExitAction(active, info?.deadOnAttach === true, resumeTriedRef.current.has(active.id))
    if (action === "close") {
      closeExitedTab(active.id)
      return
    }
    if (action === "resume") {
      resumeTriedRef.current.add(active.id)
      getDefaultPtyRegistry().release(tabPtyKey(props.taskId, active.id))
      setResetToken((n) => n + 1)
      return
    }
    degradeToShell(active.id)
  }

  const requestRename = (): void => {
    if (!active) return
    void RenameTaskDialog.show(dialog, tabTitle(active, props.vendor, liveTitles.get(active.id)), {
      dialogTitle: t("terminal.tab.renameTitle"),
      fieldLabel: t("terminal.tab.renameField"),
      submitLabel: t("terminal.tab.renameSubmit"),
      allowEmpty: true,
    }).then((title) => {
      if (title === undefined) return
      update(renameActiveTab(state, title))
    })
  }

  const requestChooseEngine = (): void => {
    void (async () => {
      const available = await availableEngineIds()
      const picked = await EnginePickerDialog.show(dialog, available, props.vendor, { allowShell: true })
      if (picked === undefined) return
      // "shell" = a plain terminal tab (kind "command"): no session pin, no
      // vendor preference write, closes itself on exit. Null label so the
      // tab is named by its live foreground process ("zsh", "vim"…).
      if (picked === "shell") {
        update(openCommandTab(state, [defaultShell()], null))
        return
      }
      update(pinSession(addTab(state, picked), picked))
      props.onChooseEngine?.(picked)
      try {
        setRepoLastActiveVendor(resolveMainRepoRoot(props.worktree), picked)
      } catch {
        /* best-effort: a stale worktree path must not block the new tab */
      }
    })()
  }

  /** What a plain ctrl+t tab should run — the full preference chain.
   *  Always CONCRETE: the tab pins the vendor it actually spawns. The old
   *  "inherit" mode (undefined when equal to the task engine) let a later
   *  task-vendor switch relabel and re-target every earlier tab. */
  const preferredTabVendor = (): VendorId => {
    try {
      return resolvePreferredVendor(resolveMainRepoRoot(props.worktree))
    } catch {
      return props.vendor
    }
  }

  /** Quick-fork (issue #17, ctrl+f): open the same composer `<prefix> f`
   *  uses, seeded from THIS task's repo/branch/engine. Repo is fixed (not
   *  editable here — same constraint quick-task/host.tsx documents); the
   *  parent creates the child task on submit. */
  const requestQuickFork = (): void => {
    void (async () => {
      let repo: string
      try {
        repo = resolveMainRepoRoot(props.worktree)
      } catch {
        return
      }
      const detected = await availableEngineIds()
      const defaultVendor = quickForkDefaultVendor(repo, detected)
      const engines = detected.length > 0 ? detected : [defaultVendor]
      const result = await QuickTaskComposer.show(dialog, quickForkComposerOptions(repo, engines, defaultVendor))
      if (result === undefined) return
      props.onQuickFork?.(repo, result)
    })()
  }

  useBindings(() => ({
    enabled: props.focused,
    bindings: bindByIds({
      "chat.tab.new": () => {
        const preferred = preferredTabVendor()
        update(pinSession(addTab(state, preferred), preferred))
      },
      "chat.tab.chooseEngine": requestChooseEngine,
      "chat.tab.cycle-next": () => update(cycleTab(state, 1)),
      "chat.tab.cycle-prev": () => update(cycleTab(state, -1)),
      "chat.fork.new": requestQuickFork,
    }),
  }))

  // ctrl+w / F2 share their chords with TerminalSplit's leaf-level close/
  // rename. In React the keymap stack puts ANCESTORS on top (mount effects
  // run children-first — see keymap.ts), so these tab-level entries would
  // always shadow the split ones. Gate them off while the active tab is
  // actually split (>1 leaf) so the chords fall through the LIFO stack to
  // the leaf bindings — the Solid-era precedence, restored by gating
  // instead of ordering.
  const activeIsSplit = isTabSplit(active.splitTree)
  useBindings(() => ({
    enabled: props.focused && !activeIsSplit,
    bindings: bindByIds({
      "chat.tab.close": () => {
        const closing = state.tabs.find((tb) => tb.id === state.activeId)
        const { state: next, closedId } = closeActiveTab(state)
        if (!closedId) {
          notif.notify({
            kind: "error",
            taskId: props.taskId,
            tabId: state.activeId,
            title: t("terminal.tab.cannotCloseLast"),
          })
          return
        }
        update(next)
        releaseSplitLeaves(tabPtyKey(props.taskId, closedId), closing?.splitTree ?? null)
        getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
      },
      "chat.tab.rename": requestRename,
    }),
  }))

  return (
    <box flexDirection="column" flexGrow={1}>
      {/* Tab strip — flush to the pane edge, dense, hidden for one tab. */}
      {state.tabs.length > 1 ? (
        <TabStrip
          tabs={state.tabs}
          activeId={state.activeId}
          turnStates={turnStates}
          onSelect={(tabId) => update(selectTab(state, tabId))}
          vendor={props.vendor}
          liveTitles={liveTitles}
          turnVendors={turnVendors}
        />
      ) : null}
      {/* Spawn gate: while restart verification runs (millisecond-scale
          transcript reads), nothing may spawn. */}
      {hydrating ? (
        <box flexGrow={1} paddingLeft={1} paddingTop={1}>
          <text fg={theme.textMuted}>{t("terminal.restoring")}</text>
        </box>
      ) : (
        <TerminalSplit
          tabKey={tabPtyKey(props.taskId, active.id)}
          cwd={props.worktree}
          command={activeCommand()}
          splitTree={active.splitTree ?? null}
          onSplitChange={(next) => update(setTabSplit(state, active.id, next))}
          onExit={handleActiveExit}
          resetToken={resetToken}
          focused={props.focused}
          onRequestFocus={props.onRequestFocus}
          // Engine leaf name = the tab's first-prompt title (title ?? auto),
          // NOT the "group N" fallback.
          engineTitle={active.title ?? active.autoTitle ?? null}
        />
      )}
    </box>
  )
}
