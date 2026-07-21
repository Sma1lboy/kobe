/** @jsxImportSource @opentui/react */
/**
 * Workspace terminal tabs (issue #16, React port). The PTY-world chattab:
 * a strip of engine-terminal tabs above the embedded Terminal pane; every tab
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
 * cycle. Per-task tab state lives in the module-level map owned by
 * `terminal-tabs-shared.ts` (shared with non-mounted writers like the
 * kanban issue-start paths), so switching tasks and back preserves each
 * task's tabs — their PTYs already survive via the registry's
 * acquire-reuse.
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
 * ref, not a captured render-time value. Everywhere else reads the plain
 * `state`/`props` — recreated fresh every render, the guarantee Solid's
 * accessors gave for free. `onEditorTabReady`/`onEngineSendReady` hand
 * their callback to the parent once per mount, re-fired on remount.
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
import { shellIdentityInput } from "../../tui/workspace/terminal-tab-spawn"
import {
  type EngineTab,
  type TabSpawn,
  type TabsState,
  addTab,
  closeActiveTab,
  closeTab,
  cycleTab,
  engineTabSpawnFor,
  initialTabs,
  isTabSplit,
  openCommandTab,
  recycleTabs,
  rehydrateTabs,
  renameActiveTab,
  selectTab,
  setTabSessionId,
  setTabSplit,
  tabCwdFor,
  tabExitAction,
  tabPtyKey,
  tabPtyKeyFor,
} from "../../tui/workspace/terminal-tabs-core"
import type { HookTabState } from "../../tui/workspace/turn-state-merge"
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
import { terminalTabsKey } from "./terminal-tabs-persist"
import { tabActivationListeners, tabsByTask, takeTabActivation } from "./terminal-tabs-shared"
import { useTabDialogs } from "./use-tab-dialogs"
import { useTabHandoffs } from "./use-tab-handoffs"
import { useTabHydration, useTabNaming } from "./use-tab-lifecycle"
import { useTabTurnState } from "./use-tab-turn-state"

export interface TerminalTabsProps {
  taskId: string
  worktree: string
  repo?: string
  taskKind?: "main" | "task" | "dir"
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
  /** This task's slice of the daemon's per-tab `engine-state` push —
   *  hook-wins over the quiescence poll (see `use-tab-turn-state`). */
  hookTabStates?: ReadonlyMap<string, HookTabState>
  /** Task title — background-toast context line (under the tab label). */
  taskTitle?: string
  /** The user landed on a tab (switch or mount) — the host resolves any
   *  pending Inbox episode targeting it. */
  onTabVisited?: (tabId: string) => void
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
  const persistKey = terminalTabsKey(props.taskId)

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

  // Attention-jump tab activation (F7): consume a pending request for this
  // task — on mount (the host just selected the task, then TerminalTabs
  // mounted) and on requests fired while already mounted. A request naming a
  // tab that no longer exists is dropped. Mount-only; reads via refs.
  const updateRef = useLatest(update)
  useEffect(() => {
    const consume = (): void => {
      const tabId = takeTabActivation(propsRef.current.taskId)
      if (!tabId) return
      const s = stateRef.current
      if (s.activeId !== tabId && s.tabs.some((tab) => tab.id === tabId)) updateRef.current(selectTab(s, tabId))
    }
    consume()
    tabActivationListeners.add(consume)
    return () => {
      tabActivationListeners.delete(consume)
    }
  }, [])

  /** Engine-tab spawn: the composition (shell wrap + resume-vs-pin +
   *  first-spawn initial prompt, issue #17) is pure — `engineTabSpawnFor`;
   *  this closure only supplies the IO reads (registry liveness, props). */
  const engineTabSpawn = (tab: EngineTab): TabSpawn => {
    const base = tab.vendor ? interactiveEngineCommand(tab.vendor, props.modelEffort) : props.command
    const live = getDefaultPtyRegistry().has(tabPtyKeyFor(props.taskId, tab))
    return engineTabSpawnFor(stateRef.current, tab, base, {
      live,
      shell: defaultShell(),
      prompt: propsRef.current.initialPrompt,
      task: {
        id: props.taskId,
        kind: props.taskKind,
        vendor: tab.vendor ?? props.vendor,
        repo: props.repo,
      },
      worktreePath: props.worktree,
    })
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

  /* --------- per-tab turn state (hook-first, poll-fallback) --------- */
  const { turnStates, liveTitles, turnVendors } = useTabTurnState({
    taskId: props.taskId,
    worktree: props.worktree,
    vendor: props.vendor,
    state,
    sharedActivity: props.sharedActivity,
    hookTabStates: props.hookTabStates,
    taskTitle: props.taskTitle,
    notif,
  })

  // Visiting a tab clears its unread mark (toast already auto-dismisses)
  // and reports the visit upstream — the host resolves any pending Inbox
  // episode targeting this tab (visited = handled, no explicit open needed).
  // biome-ignore lint/correctness/useExhaustiveDependencies: fires only on a real activeId transition, matching the Solid `on(...)` guard; `notif`/`taskId` are stable for this component's lifetime.
  useEffect(() => {
    notif.markRead(props.taskId, state.activeId)
    propsRef.current.onTabVisited?.(state.activeId)
  }, [state.activeId])

  /** Auto-close (issue #16): a tab closes itself when its process exits
   *  and releases its PTY. Reads the FRESH state (`stateRef`) — exit
   *  events can arrive from a stale render (see `handleActiveExit`). */
  function closeExitedTab(id: string): void {
    const current = stateRef.current
    const closing = current.tabs.find((tb) => tb.id === id)
    const { state: next, closedId } = closeTab(current, id)
    if (closedId) {
      const key = closing ? tabPtyKeyFor(props.taskId, closing) : tabPtyKey(props.taskId, closedId)
      releaseSplitLeaves(key, closing?.splitTree ?? null)
      getDefaultPtyRegistry().release(key)
    }
    update(next)
  }

  const activeSpawn = (): TabSpawn =>
    active.kind === "command"
      ? {
          command: active.command,
          // A BARE shell tab (ctrl+e "shell" pick — the tab IS the user's
          // shell, no editor purpose) gets the identity export typed in, so
          // a user-typed engine's hooks report tab-precise events +
          // sessionId. Editor/one-off command tabs skip it (meaningless for
          // nvim, and the argv isn't a prompt to type into).
          ...(active.purpose !== "editor" && active.command.length === 1 && active.command[0] === defaultShell()
            ? { initialInput: shellIdentityInput(props.taskId, active.id) }
            : {}),
        }
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
      getDefaultPtyRegistry().release(tabPtyKeyFor(props.taskId, active))
      setResetToken((n) => n + 1)
      return
    }
    if (stateRef.current.tabs.length > 1) {
      closeExitedTab(active.id)
      return
    }
    // Last tab: the strip can never be empty — recycle it in place as a
    // fresh engine tab (new session) instead of freezing on the exit banner.
    // `recycleTabs` carries the old tab's title/autoTitle so the recycle
    // doesn't visibly rename the tab.
    getDefaultPtyRegistry().release(tabPtyKeyFor(props.taskId, active))
    resumeTriedRef.current.clear()
    const fresh = pinSession(recycleTabs(active), undefined)
    update(fresh)
    if (fresh.activeId === active.id) setResetToken((n) => n + 1)
  }

  // Rename / choose-engine / quick-fork dialog flows — extracted verbatim
  // (file-size cap split); recreated per render for state freshness.
  const { requestRename, requestChooseEngine, requestQuickFork } = useTabDialogs({
    dialog,
    t,
    state,
    active,
    vendor: props.vendor,
    worktree: props.worktree,
    liveTitles,
    update,
    pinSession,
    onChooseEngine: props.onChooseEngine,
    onQuickFork: props.onQuickFork,
  })

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
        const key = closing ? tabPtyKeyFor(props.taskId, closing) : tabPtyKey(props.taskId, closedId)
        releaseSplitLeaves(key, closing?.splitTree ?? null)
        // A viewport tab (ptyTask) only VIEWS another task's session —
        // ctrl+w removes the view; the story's session keeps running and
        // its own task still resumes it.
        if (!(closing?.kind === "engine" && closing.ptyTask)) getDefaultPtyRegistry().release(key)
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
          tabKey={tabPtyKeyFor(props.taskId, active)}
          cwd={tabCwdFor(active, props.worktree)}
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
