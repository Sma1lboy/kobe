/**
 * Pure tab-list state for the workspace terminal tabs (issue #16) — the
 * PTY-world successor of the tmux chattab concept. Same user contract:
 * new tab spawns the SAME engine command in the same worktree, the last
 * tab can't be closed, titles are user-renameable, bracket chords cycle.
 *
 * Framework-free on purpose: the Solid component owns signals/UI, this
 * module owns the transitions so vitest can pin them. Tab PTYs are keyed
 * `${taskId}::${tabId}` into the existing PtyRegistry — no registry
 * changes; each tab is just another registry entry that survives task
 * switches (acquire-reuse) until closed.
 */

import type { VendorId } from "@/types/vendor"

export interface TerminalTab {
  /** Stable id — registry key suffix. Never reused within a task. */
  readonly id: string
  /** User title; null = untitled (view shows the numbered default). */
  readonly title: string | null
  /** 1-based creation ordinal — drives the "Terminal {n}" default. */
  readonly ordinal: number
  /**
   * Vendor override for THIS tab only (chosen via `chat.tab.chooseEngine`).
   * Undefined = inherit the task's current engine, like every plain
   * `chat.tab.new` tab.
   */
  readonly vendor?: VendorId
  /**
   * One-off shell argv this tab runs instead of the task's engine command
   * (the FileTree "open in editor" flow — see `openEditorTab`). Undefined
   * for every ordinary engine tab.
   */
  readonly command?: readonly string[]
  /**
   * Set alongside `command`: this tab closes itself (and releases its PTY)
   * when its process exits, the PTY-world equivalent of tmux closing an
   * editor's transient window on quit. Ordinary engine tabs instead
   * degrade to a plain shell on exit (`tabToShell`), so this is never
   * set without `command`.
   */
  readonly ephemeral?: boolean
}

export interface TabsState {
  readonly tabs: readonly TerminalTab[]
  readonly activeId: string
  /** Next ordinal to hand out (monotonic — close does not recycle). */
  readonly nextOrdinal: number
}

/** A task's initial state: one untitled tab, active. */
export function initialTabs(): TabsState {
  return { tabs: [{ id: "tab-1", title: null, ordinal: 1 }], activeId: "tab-1", nextOrdinal: 2 }
}

/** Shared insert: append `tab` after the active tab and focus it. */
function insertAfterActive(state: TabsState, tab: TerminalTab): TabsState {
  const i = state.tabs.findIndex((t) => t.id === state.activeId)
  const tabs = [...state.tabs.slice(0, i + 1), tab, ...state.tabs.slice(i + 1)]
  return { tabs, activeId: tab.id, nextOrdinal: state.nextOrdinal + 1 }
}

/**
 * Open a new tab after the active one and focus it. `vendor` pins that tab
 * to a specific engine (the `chat.tab.chooseEngine` flow); omitted, it
 * inherits the task's current engine like every plain `ctrl+t` tab.
 */
export function addTab(state: TabsState, vendor?: VendorId): TabsState {
  const ordinal = state.nextOrdinal
  return insertAfterActive(state, { id: `tab-${ordinal}`, title: null, ordinal, vendor })
}

/**
 * Open a one-off editor tab after the active tab and focus it — the
 * PTY-world equivalent of tmux's `openInEditor` transient window
 * (`tmux/editor-launch.ts`): runs the already-resolved `command` (e.g.
 * `["sh", "-c", "nvim -d ..."]`), labeled `label` (the file's basename),
 * and closes itself when the process exits (`ephemeral`, consumed by
 * `TerminalTabs.tsx`'s `onExit` wiring).
 */
export function openEditorTab(state: TabsState, command: readonly string[], label: string): TabsState {
  const ordinal = state.nextOrdinal
  return insertAfterActive(state, { id: `tab-${ordinal}`, title: label, ordinal, command, ephemeral: true })
}

/**
 * Degrade an engine tab whose CLI exited into a plain shell tab. Exiting
 * the vendor CLI is an allowed action, not an error (owner decision
 * 2026-07-06): the tab keeps its identity (id/title/ordinal) and respawns
 * as `shell` in the same worktree instead of freezing behind the
 * dead-shell exit banner. No-op if the tab is gone or already runs a
 * one-off `command` (editor tabs close themselves on exit instead, and a
 * degraded shell tab closes on its next exit — see `TerminalTabs.tsx`).
 */
export function tabToShell(state: TabsState, id: string, shell: readonly string[]): TabsState {
  const tabs = state.tabs.map((t) => (t.id === id && !t.command ? { ...t, vendor: undefined, command: shell } : t))
  return { ...state, tabs }
}

/**
 * Close a specific tab by id, focusing its left neighbor if it was the
 * active tab (right neighbor when closing the first) — same neighbor rule
 * as `closeActiveTab`, generalized so an ephemeral editor tab can close
 * itself on exit even when the user has since switched to another tab.
 * Refuses to close the only tab; no-op (`closedId: null`) if `id` isn't
 * present.
 */
export function closeTab(state: TabsState, id: string): { state: TabsState; closedId: string | null } {
  if (state.tabs.length <= 1) return { state, closedId: null }
  const i = state.tabs.findIndex((t) => t.id === id)
  if (i < 0) return { state, closedId: null }
  const tabs = state.tabs.filter((t) => t.id !== id)
  if (state.activeId !== id) return { state: { ...state, tabs }, closedId: id }
  const next = tabs[Math.max(0, i - 1)]
  return { state: { ...state, tabs, activeId: (next ?? tabs[0]).id }, closedId: id }
}

/**
 * Close the active tab, focusing its left neighbor (right neighbor when
 * closing the first). Refuses to close the only tab — same guard the
 * tmux chattab had; the caller surfaces the refusal, state is unchanged.
 */
export function closeActiveTab(state: TabsState): { state: TabsState; closedId: string | null } {
  return closeTab(state, state.activeId)
}

/** Rename the active tab; empty/whitespace titles clear back to default. */
export function renameActiveTab(state: TabsState, title: string): TabsState {
  const trimmed = title.trim()
  const tabs = state.tabs.map((t) =>
    t.id === state.activeId ? { ...t, title: trimmed.length > 0 ? trimmed : null } : t,
  )
  return { ...state, tabs }
}

/** Cycle the active tab by ±1, wrapping at the ends. */
export function cycleTab(state: TabsState, delta: 1 | -1): TabsState {
  const n = state.tabs.length
  if (n <= 1) return state
  const i = state.tabs.findIndex((t) => t.id === state.activeId)
  const next = state.tabs[(i + delta + n) % n]
  return { ...state, activeId: next.id }
}

/** Registry key for one tab's PTY — namespaced so tabs never collide. */
export function tabPtyKey(taskId: string, tabId: string): string {
  return `${taskId}::${tabId}`
}
