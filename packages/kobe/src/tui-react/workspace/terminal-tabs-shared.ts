/**
 * Cross-component tab state shared between the mounted `TerminalTabs`
 * component and the host-side flows that need it while the component may
 * not be mounted — extracted from `TerminalTabs.tsx` for the file-size cap.
 * Module-level on purpose (framework-agnostic process state): per-task tab
 * snapshots survive task switches, and the F7 attention jump can request a
 * tab activation before the target task's tabs ever mount.
 */

import { engineLaunchArgv } from "../../engine/engine-presets"
import { withClaudeSessionId } from "../../engine/interactive-command"
import {
  type EngineTab,
  type TabsState,
  type TerminalTab,
  initialTabs,
  rehydrateTabs,
} from "../../tui/workspace/terminal-tabs-core"
import type { VendorId } from "../../types/vendor"
import { type TabsSnapshotKv, forgetTaskTabsSnapshot, terminalTabsKey } from "./terminal-tabs-persist"

/** Per-task tab state, preserved across task switches for the process. */
export const tabsByTask = new Map<string, TabsState>()

/** The task's currently-active tab id (module map read) — the attention
 *  jump's "where am I" input. Null when the task never mounted tabs. */
export function activeTabIdFor(taskId: string): string | null {
  return tabsByTask.get(taskId)?.activeId ?? null
}

/** The task's known tab state — live process state, else its restart
 *  snapshot, else null when this task has never opened tabs.
 *
 *  `kv` is nullable so a surface with no KV provider (render tests, a pane
 *  mounted before the context exists) still sees the live tabs instead of
 *  crashing: the in-memory map is authoritative for anything running now,
 *  and the snapshot only adds tasks that have not mounted since restart. */
function knownTabsState(kv: TabsSnapshotKv | null, taskId: string): TabsState | null {
  const live = tabsByTask.get(taskId)
  if (live) return live
  const saved = kv?.store[terminalTabsKey(taskId)] as TabsState | null | undefined
  return saved && Array.isArray(saved.tabs) ? saved : null
}

/** Resolve a tab from live process state or its restart snapshot. */
export function knownTaskTab(kv: TabsSnapshotKv, taskId: string, tabId: string): TerminalTab | undefined {
  return knownTabsState(kv, taskId)?.tabs.find((tab) => tab.id === tabId)
}

/**
 * TRI-STATE "does this tab exist" — the ONE implementation every Inbox
 * surface must use. `true` = present, `false` = the tab list was readable
 * and this tab is gone, `undefined` = the list could not be read at all
 * (this process never mounted that task's TerminalTabs, so it has no KV
 * snapshot).
 *
 * The distinction is load-bearing because callers DELETE episodes that read
 * as unavailable. `knownTaskTab(...) !== undefined` collapses "don't know"
 * into "gone" and destroys live episodes — the owner-reported "two tabs are
 * unread but the Inbox only lists one" (40641c01). That fix converted the
 * host but left the dialog, its per-row badge, and the F7 jump on the binary
 * form, so the badge counted episodes the list hid and opening such a row
 * silently dismissed it instead of navigating. Route every availability
 * question through here.
 */
export function taskTabExists(kv: TabsSnapshotKv | null, taskId: string, tabId: string): boolean | undefined {
  const known = knownTaskTabs(kv, taskId)
  if (known === null) return undefined
  return known.tabs.some((tab) => tab.id === tabId)
}

/**
 * A task's tabs as a surface that does NOT host them sees them — the sidebar
 * tree, which lists every worktree's tabs whether or not that worktree is the
 * selected one (only the selected task has a mounted TerminalTabs).
 *
 * Null means "this task has never opened tabs", which is NOT the same as an
 * empty list: the tree renders no children for the former rather than
 * claiming the worktree has zero tabs, since mounting always yields at least
 * one.
 */
export function knownTaskTabs(
  kv: TabsSnapshotKv | null,
  taskId: string,
): { tabs: readonly TerminalTab[]; activeId: string } | null {
  const state = knownTabsState(kv, taskId)
  return state ? { tabs: state.tabs, activeId: state.activeId } : null
}

/**
 * Cross-component "activate this tab" request (the F7 attention jump). The
 * mounted TerminalTabs for `taskId` consumes it via the listener; a task
 * that isn't mounted yet consumes it on mount (the host selects the task
 * first, TerminalTabs mounts, then reads the pending request). Unknown tab
 * ids are dropped on consume — the tab may have closed meanwhile.
 */
let pendingTabActivation: { taskId: string; tabId: string } | null = null
export const tabActivationListeners = new Set<() => void>()

export function requestTabActivation(taskId: string, tabId: string): void {
  pendingTabActivation = { taskId, tabId }
  for (const listener of tabActivationListeners) listener()
}

/** Consume a pending activation for this task, or null. */
export function takeTabActivation(taskId: string): string | null {
  if (pendingTabActivation?.taskId !== taskId) return null
  const tabId = pendingTabActivation.tabId
  pendingTabActivation = null
  return tabId
}

/**
 * Cross-component "open a command tab" request (`tab.open` — plugin panes).
 * pendingTabActivation's twin: consumed by the mounted TerminalTabs via the
 * same listener set, or on mount for a task selected later.
 */
let pendingTabOpen: {
  taskId: string
  argv: readonly string[]
  title: string
  tabId?: string
  placement?: "split" | "tab"
  direction?: "right" | "down"
} | null = null

export function requestTabOpen(
  taskId: string,
  argv: readonly string[],
  title: string,
  placement?: "split" | "tab",
  direction?: "right" | "down",
  tabId?: string,
): void {
  pendingTabOpen = { taskId, argv, title, placement, direction, tabId }
  for (const listener of tabActivationListeners) listener()
}

/**
 * Cross-component "close panes opened under a title" request (`tab.close` —
 * pane-close, the inverse of {@link requestTabOpen}). Consumed by the
 * mounted TerminalTabs; matching is by pane label, so only titled
 * split-leaves / command tabs (the ones tab.open creates) are affected.
 */
let pendingPaneClose: { taskId: string; title: string; tabId?: string } | null = null

export function requestPaneClose(taskId: string, title: string, tabId?: string): void {
  pendingPaneClose = { taskId, title, tabId }
  for (const listener of tabActivationListeners) listener()
}

/** Consume a pending pane-close for this task, or null. */
export function takePaneClose(taskId: string): { title: string; tabId?: string } | null {
  if (pendingPaneClose?.taskId !== taskId) return null
  const { title, tabId } = pendingPaneClose
  pendingPaneClose = null
  return { title, tabId }
}

/**
 * Cross-component "close this tab" request — the third of the same family.
 *
 * Unlike its twins, this one has a caller that can name a tab of a task whose
 * TerminalTabs is NOT mounted (the sidebar tree lists every worktree's tabs),
 * so an unconsumed request is not "wait for mount" — it means nobody owns that
 * task's state right now and the write has to happen in the background.
 * `closeTaskTab` (terminal-tabs-close.ts) is what decides between the two by
 * checking whether the request survived the listener sweep.
 */
let pendingTabClose: { taskId: string; tabId: string } | null = null

export function requestTabClose(taskId: string, tabId: string): void {
  pendingTabClose = { taskId, tabId }
  for (const listener of tabActivationListeners) listener()
}

/** Consume a pending close for this task, or null. */
export function takeTabClose(taskId: string): string | null {
  if (pendingTabClose?.taskId !== taskId) return null
  const tabId = pendingTabClose.tabId
  pendingTabClose = null
  return tabId
}

/** Whether the last {@link requestTabClose} went unclaimed — i.e. no mounted
 *  TerminalTabs owns that task. Clears the request either way. */
export function takeUnclaimedTabClose(): { taskId: string; tabId: string } | null {
  const pending = pendingTabClose
  pendingTabClose = null
  return pending
}

/**
 * Cross-component "adopt these live tab ids" request — same claim protocol as
 * {@link requestTabClose}: a mounted TerminalTabs owns its task's state and
 * must do the write itself, and only an UNCLAIMED request may be written in
 * the background. See `terminal-tabs-adopt.ts` for what adoption is for.
 */
let pendingTabAdopt: { taskId: string; tabIds: readonly string[] } | null = null

export function requestTabAdopt(taskId: string, tabIds: readonly string[]): void {
  pendingTabAdopt = { taskId, tabIds }
  for (const listener of tabActivationListeners) listener()
}

/** Consume a pending adoption for this task, or null. */
export function takeTabAdopt(taskId: string): readonly string[] | null {
  if (pendingTabAdopt?.taskId !== taskId) return null
  const tabIds = pendingTabAdopt.tabIds
  pendingTabAdopt = null
  return tabIds
}

/** The twin of {@link takeUnclaimedTabClose} for adoption. */
export function takeUnclaimedTabAdopt(): { taskId: string; tabIds: readonly string[] } | null {
  const pending = pendingTabAdopt
  pendingTabAdopt = null
  return pending
}

/** Consume a pending tab-open for this task, or null. */
export function takeTabOpen(taskId: string): {
  argv: readonly string[]
  title: string
  tabId?: string
  placement?: "split" | "tab"
  direction?: "right" | "down"
} | null {
  if (pendingTabOpen?.taskId !== taskId) return null
  const request = pendingTabOpen
  pendingTabOpen = null
  return request
}

/**
 * UI-event bridge for plugin events: the host injects the orchestrator's
 * `reportUiEvent` once; tab open/close edges (and editor-file closes)
 * report through it. No-op until wired (mock hosts, tests, pure TUI
 * before attach).
 */
type UiEventReporter = (kind: string, taskId?: string, detail?: Record<string, unknown>) => void
let uiEventReporter: UiEventReporter | null = null

export function setUiEventReporter(fn: UiEventReporter | null): void {
  uiEventReporter = fn
}

function tabDetail(tab: TerminalTab): Record<string, unknown> {
  return {
    tabId: tab.id,
    kind: tab.kind,
    ...(tab.title ? { title: tab.title } : {}),
    ...(tab.kind === "engine" && tab.vendor ? { vendor: tab.vendor } : {}),
    ...(tab.kind === "command" && tab.purpose ? { purpose: tab.purpose } : {}),
  }
}

/**
 * Report tab.opened / tab.closed (+ file.closed when the closing tab is the
 * editor singleton) off one state transition. Called from the mounted
 * TerminalTabs' single state writer; mount-time restores never pass through
 * it, so restored tabs don't re-announce as opened.
 */
export function reportTabsDelta(taskId: string, prev: readonly TerminalTab[], next: readonly TerminalTab[]): void {
  if (!uiEventReporter || prev === next) return
  const report = uiEventReporter
  const prevIds = new Set(prev.map((tab) => tab.id))
  const nextIds = new Set(next.map((tab) => tab.id))
  for (const tab of next) if (!prevIds.has(tab.id)) report("tab.opened", taskId, tabDetail(tab))
  for (const tab of prev) {
    if (nextIds.has(tab.id)) continue
    report("tab.closed", taskId, tabDetail(tab))
    if (tab.kind === "command" && tab.purpose === "editor") {
      // The editor tab's argv ends with the absolute file path (host-built).
      const path = [...tab.command].reverse().find((arg) => arg.startsWith("/"))
      report("file.closed", taskId, { ...(path ? { path } : {}), ...(tab.title ? { title: tab.title } : {}) })
    }
  }
}

/**
 * Reclaim a DELETED task's in-process + persisted tab state (O19): drop its
 * `tabsByTask` entry (module-level, otherwise only-grows) and its
 * `terminalTabs.*` kv snapshot. Call from the task-DELETE flow only — never
 * the archived sweep (an archived task must keep its snapshot to
 * unarchive-and-`--resume`). Its PTYs are released separately by the host's
 * archived-task sweep / the tab's own exit path.
 */
export function forgetTaskTabs(kv: TabsSnapshotKv, taskId: string): void {
  tabsByTask.delete(taskId)
  forgetTaskTabsSnapshot(kv, taskId)
}

/** The task's current tab state as a NON-mounted flow sees it: the live
 *  module entry, else the persisted snapshot, else a fresh single tab. */
function currentTabsState(kv: TabsSnapshotKv, taskId: string, shell: string): TabsState {
  const inMemory = tabsByTask.get(taskId)
  if (inMemory) return inMemory
  const saved = kv.store[terminalTabsKey(taskId)] as TabsState | null | undefined
  return saved && Array.isArray(saved.tabs) ? rehydrateTabs(saved, [shell]) : initialTabs()
}

/**
 * Append an already-spawned engine tab to a task whose TerminalTabs is NOT
 * mounted — the kanban issue-start paths ("new chattab in the project
 * workspace", jump or stay). Writes the module map AND the kv snapshot so
 * the next mount (or restart) renders the tab and attaches to its live PTY.
 * Returns the created tab; the caller spawns its PTY under
 * `tabPtyKeyFor(taskId, tab)` before or right after this write.
 */
export function appendBackgroundEngineTab(
  kv: TabsSnapshotKv,
  taskId: string,
  shell: string,
  spec: {
    vendor: VendorId
    /** Pass the referenced session's id for a viewport tab (`ptyTask`) so a
     *  dead-reattach resumes THAT conversation; omit to pin a fresh one. */
    sessionId?: string | null
    ptyTask?: EngineTab["ptyTask"]
  },
): { state: TabsState; tab: EngineTab } {
  const state = currentTabsState(kv, taskId, shell)
  const ordinal = state.nextOrdinal
  const sessionId =
    spec.sessionId !== undefined
      ? spec.sessionId
      : withClaudeSessionId(engineLaunchArgv({ vendor: spec.vendor }), spec.vendor).sessionId
  const tab: EngineTab = {
    kind: "engine",
    id: `tab-${ordinal}`,
    title: null,
    ordinal,
    vendor: spec.vendor,
    sessionId,
    spawned: true,
    ...(spec.ptyTask ? { ptyTask: spec.ptyTask } : {}),
  }
  const next: TabsState = {
    tabs: [...state.tabs, tab],
    activeId: tab.id,
    nextOrdinal: ordinal + 1,
  }
  tabsByTask.set(taskId, next)
  kv.set(terminalTabsKey(taskId), next)
  return { state: next, tab }
}
