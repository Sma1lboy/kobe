/** @jsxImportSource @opentui/react */
/**
 * Workspace terminal tabs (issue #16) — React port of `tui/workspace/
 * TerminalTabs.tsx` (issue #16 React migration). The PTY-world chattab: a
 * strip of engine-terminal tabs above the embedded Terminal pane; every tab
 * runs the user's SHELL in its own PTY (registry key `${taskId}::${tabId}`)
 * with the interactive engine command TYPED into it (`shellSpawn`), so
 * ctrl+t gives a parallel session in the same
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
import { warmHostedShell } from "../../tui/panes/terminal/pty-hosted"
import { defaultShell } from "../../tui/panes/terminal/pty-types"
import { getDefaultPtyRegistry } from "../../tui/panes/terminal/registry"
import {
  type EngineTab,
  type TabSpawn,
  type TabsState,
  addTab,
  closeActiveTab,
  closeTab,
  cycleTab,
  engineTabArgv,
  initialTabs,
  isTabSplit,
  openCommandTab,
  rehydrateTabs,
  renameActiveTab,
  selectTab,
  setTabSessionId,
  setTabSplit,
  shellSpawn,
  tabExitAction,
  tabPtyKey,
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
import { useLatest } from "../lib/use-latest"
import { PreviewScreen } from "../ops/preview"
import { useDialog } from "../ui/dialog"
import { TerminalSplit, releaseSplitLeaves } from "./TerminalSplit"
import { quickForkComposerOptions, quickForkDefaultVendor } from "./quick-fork"
import { TabStrip, tabTitle } from "./tab-strip"
import { useTabHandoffs } from "./use-tab-handoffs"
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
  /** Hands the parent an imperative "open this file's read-only diff in a
   *  content tab" function, once per mount — the FileTree `d` action (issue
   *  #21). Opening is a content swap, not a focus grab (KOB-25). */
  onDiffTabReady?: (open: (relPath: string, label: string, base?: string) => void) => void
  /** Quick-fork (issue #17): the composer submitted — parent creates the
   *  child task (in `repo`, the source task's main repo root) and jumps in. */
  onQuickFork?: (repo: string, result: QuickTaskResult) => void
  /** Quick-fork phase 2: a prompt auto-delivered to this task's first
   *  engine tab. Rides the engine argv as a positional arg on that tab's
   *  FIRST spawn (`engineTabSpawn`) — once the session has spawned or
   *  conversed it never re-applies. */
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
  const propsRef = useLatest(props)

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
  const stateRef = useLatest(state)

  const update = (next: TabsState): void => {
    tabsByTask.set(propsRef.current.taskId, next)
    stateRef.current = next
    setState(next)
    kv.set(persistKey, next)
  }

  /** Engine-tab spawn: the PTY runs the user's SHELL and the engine argv
   *  (pinned session id riding it — resume-vs-pin is pure, `engineTabArgv`)
   *  is TYPED into it (`shellSpawn`), so exiting the vendor lands on a
   *  normal prompt with full rc context. The quick-fork initial prompt
   *  (issue #17) rides the argv as a positional arg on the first engine
   *  tab's FIRST spawn — pasting it into the PTY raced the shell (typed
   *  input executed by the shell, not the engine). */
  const engineTabSpawn = (tab: EngineTab): TabSpawn => {
    const base = tab.vendor ? interactiveEngineCommand(tab.vendor, props.modelEffort) : props.command
    const live = getDefaultPtyRegistry().has(tabPtyKey(props.taskId, tab.id))
    const prompt = propsRef.current.initialPrompt
    const firstEngine = stateRef.current.tabs.find((t) => t.kind === "engine")
    const wantsPrompt = !!prompt && tab.id === firstEngine?.id && !tab.spawned && !live
    return shellSpawn(engineTabArgv(tab, wantsPrompt ? [...base, prompt] : base, live), defaultShell())
  }
  // Latest-render mirror for the mount-once engine-send closure below —
  // same freshness convention as propsRef/stateRef (file header).
  const engineTabSpawnRef = useLatest(engineTabSpawn)

  /** Nudge Terminal to re-acquire under the CURRENTLY visible tab's key —
   *  see the `resetToken` doc on `Terminal.tsx`. */
  const [resetToken, setResetToken] = useState(0)

  /* --------- restart resume verification (issue #22) — mount-only ------- */
  const hydrating = useTabHydration(rehydratedRef.current, { stateRef, propsRef, update })

  // Parent handoffs — mount-once effects, extracted to use-tab-handoffs.ts
  // (file-size cap split). The quick-fork initial prompt no longer needs a
  // delivery effect: it rides the first spawn's argv (engineTabSpawn).
  useTabHandoffs({
    stateRef,
    propsRef,
    update,
    engineTabSpawnRef,
    bumpResetToken: () => setResetToken((n) => n + 1),
  })

  // Warm one spare shell for this worktree in the pty host so the next
  // engine/shell tab adopts an already-initialized shell (rc files done)
  // instead of paying shell startup. Best-effort fire-and-forget.
  useEffect(() => {
    warmHostedShell(props.worktree)
  }, [props.worktree])

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

  /** Auto-close (issue #16): a tab closes itself when its process exits
   *  and releases its PTY. Reads the FRESH state (`stateRef`) — exit
   *  events can arrive from a stale render (see `handleActiveExit`). */
  function closeExitedTab(id: string): void {
    const current = stateRef.current
    const closing = current.tabs.find((tb) => tb.id === id)
    const { state: next, closedId } = closeTab(current, id)
    if (closedId) {
      releaseSplitLeaves(tabPtyKey(props.taskId, closedId), closing?.splitTree ?? null)
      getDefaultPtyRegistry().release(tabPtyKey(props.taskId, closedId))
    }
    update(next)
  }

  const activeSpawn = (): TabSpawn =>
    active.kind === "command"
      ? { command: active.command }
      : active.kind === "content"
        ? // Content tabs have no PTY (a read-only preview); the render below
          // never mounts a Terminal for them, so this spawn is never used.
          { command: [] }
        : engineTabSpawn(active)

  /** Engine tabs whose dead-on-attach resume was already attempted — one
   *  shot per tab, so a `--resume` that itself dies closes normally
   *  instead of respawning forever. */
  const resumeTriedRef = useRef(new Set<string>())

  function handleActiveExit(info?: { deadOnAttach?: boolean }): void {
    // An exit event can be the echo of an intentional ctrl+w: closing kills
    // the PTY, which fires onExit into THIS (stale) render before React
    // swaps the Terminal. If the tab is already gone from the fresh state
    // there is nothing to do — acting on the stale snapshot resurrected
    // the closed tab (the "ctrl+w needs two presses" bug).
    if (!stateRef.current.tabs.some((t) => t.id === active.id)) return
    // Policy is pure (`tabExitAction`): a live exit means the tab's SHELL
    // ended (engines run inside it — `shellSpawn`), so the tab closes; a
    // corpse found on reattach (host restart, machine reboot) gets ONE
    // resume — releasing the dead handle makes `engineTabSpawn` type
    // `--resume <sessionId>` on the re-acquire (`spawned && !live`).
    const action = tabExitAction(active, info?.deadOnAttach === true, resumeTriedRef.current.has(active.id))
    if (action === "resume") {
      resumeTriedRef.current.add(active.id)
      getDefaultPtyRegistry().release(tabPtyKey(props.taskId, active.id))
      setResetToken((n) => n + 1)
      return
    }
    if (stateRef.current.tabs.length > 1) {
      closeExitedTab(active.id)
      return
    }
    // Last tab: the strip can never be empty — recycle it in place as a
    // fresh engine tab (new session) instead of freezing on the exit banner.
    getDefaultPtyRegistry().release(tabPtyKey(props.taskId, active.id))
    resumeTriedRef.current.clear()
    const fresh = pinSession(initialTabs(), undefined)
    update(fresh)
    if (fresh.activeId === active.id) setResetToken((n) => n + 1)
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
  const spawn = activeSpawn()
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
      ) : active.kind === "content" ? (
        // Read-only diff/preview tab (issue #21) — the shared PreviewScreen,
        // no PTY. `onClose` (q/esc) closes THIS tab instead of exiting the
        // process (the standalone entrypoint keeps the process.exit default).
        <PreviewScreen
          worktree={props.worktree}
          relPath={active.relPath}
          base={active.base}
          focused={props.focused}
          onClose={() => closeExitedTab(active.id)}
        />
      ) : (
        <TerminalSplit
          tabKey={tabPtyKey(props.taskId, active.id)}
          cwd={props.worktree}
          command={spawn.command}
          initialInput={spawn.initialInput}
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
