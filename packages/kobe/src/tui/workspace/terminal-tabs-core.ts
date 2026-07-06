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

interface TabBase {
  /** Stable id — registry key suffix. Never reused within a task. */
  readonly id: string
  /** User title; null = untitled (view shows the numbered default). */
  readonly title: string | null
  /** 1-based creation ordinal — drives the "Terminal {n}" default. */
  readonly ordinal: number
  /**
   * Auto-derived title (the tab's own engine session's first prompt — the
   * PTY-world `runChatTabNamingPass`). Display precedence is
   * `title ?? autoTitle ?? numbered default`: a manual F2 rename always
   * wins, and clearing one falls back here — tmux's automatic-rename
   * semantics. On the base so a tab degraded to a shell (`tabToShell`)
   * keeps the name of the conversation it hosted.
   */
  readonly autoTitle?: string | null
}

/**
 * Runs an interactive engine CLI. When its process exits, the tab
 * degrades in place to a {@link CommandTab} running the user's shell
 * (`tabToShell`) — exiting the vendor is allowed, not an error.
 */
export interface EngineTab extends TabBase {
  readonly kind: "engine"
  /**
   * Vendor override for THIS tab only (chosen via `chat.tab.chooseEngine`).
   * Undefined = inherit the task's current engine, like every plain
   * `chat.tab.new` tab.
   */
  readonly vendor?: VendorId
  /**
   * Engine session id pinned at spawn (`withClaudeSessionId` — the same
   * `--session-id` mapping the tmux chattab stashed as
   * `@kobe_session_id`), so the tab is auto-named from ITS OWN first
   * prompt and can later be resumed. Null for vendors that can't take a
   * caller-set id (codex/custom — their origin tab is named from the
   * worktree instead, matching the tmux fallback).
   */
  readonly sessionId?: string | null
  /**
   * True once this tab's PTY has actually spawned. Drives the restart
   * story (issue #22): a persisted engine tab that already ran resumes
   * its conversation (`--resume <sessionId>`) instead of opening a
   * blank session under the same id.
   */
  readonly spawned?: boolean
}

/**
 * Runs a fixed one-off argv: an editor tab (the FileTree "open in
 * editor" flow, see `openEditorTab`) or an engine tab degraded to the
 * user's shell (`tabToShell`). Closes itself (and releases its PTY)
 * when its process exits — the PTY-world equivalent of tmux closing an
 * editor's transient window on quit.
 */
export interface CommandTab extends TabBase {
  readonly kind: "command"
  readonly command: readonly string[]
}

/**
 * Discriminated on `kind` so the illegal shapes (vendor+command on one
 * tab, close-on-exit without a command) cannot be represented.
 */
export type TerminalTab = EngineTab | CommandTab

export interface TabsState {
  readonly tabs: readonly TerminalTab[]
  readonly activeId: string
  /** Next ordinal to hand out (monotonic — close does not recycle). */
  readonly nextOrdinal: number
}

/** A task's initial state: one untitled engine tab, active. */
export function initialTabs(): TabsState {
  return { tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1 }], activeId: "tab-1", nextOrdinal: 2 }
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
  return insertAfterActive(state, { kind: "engine", id: `tab-${ordinal}`, title: null, ordinal, vendor })
}

/**
 * Open a one-off editor tab after the active tab and focus it — the
 * PTY-world equivalent of tmux's `openInEditor` transient window
 * (`tmux/editor-launch.ts`): runs the already-resolved `command` (e.g.
 * `["sh", "-c", "nvim -d ..."]`), labeled `label` (the file's basename),
 * and closes itself when the process exits (kind "command", consumed by
 * `TerminalTabs.tsx`'s `onExit` wiring).
 */
export function openEditorTab(state: TabsState, command: readonly string[], label: string): TabsState {
  const ordinal = state.nextOrdinal
  return insertAfterActive(state, { kind: "command", id: `tab-${ordinal}`, title: label, ordinal, command })
}

/**
 * Degrade an engine tab whose CLI exited into a plain shell tab. Exiting
 * the vendor CLI is an allowed action, not an error (owner decision
 * 2026-07-06): the tab keeps its identity (id/title/ordinal) and respawns
 * as `shell` in the same worktree instead of freezing behind the
 * dead-shell exit banner. No-op if the tab is gone or already a command
 * tab (those close themselves on exit instead — see `TerminalTabs.tsx`).
 */
export function tabToShell(state: TabsState, id: string, shell: readonly string[]): TabsState {
  const tabs = state.tabs.map(
    (t): TerminalTab =>
      t.id === id && t.kind === "engine"
        ? { kind: "command", id: t.id, title: t.title, ordinal: t.ordinal, autoTitle: t.autoTitle, command: shell }
        : t,
  )
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

/**
 * Record the engine session id pinned at PTY spawn on an engine tab.
 * Separate transition (not an `addTab` parameter) because the id is
 * IO-generated (`randomUUID` in `withClaudeSessionId`) — this module
 * stays pure so vitest can pin every transition.
 */
export function setTabSessionId(state: TabsState, id: string, sessionId: string | null): TabsState {
  const tabs = state.tabs.map((t): TerminalTab => (t.id === id && t.kind === "engine" ? { ...t, sessionId } : t))
  return { ...state, tabs }
}

/**
 * Record an auto-derived title. Self-limiting like the tmux naming pass:
 * callers only derive for tabs with neither a user title nor an
 * autoTitle, and the display precedence keeps a later F2 rename on top.
 */
export function setTabAutoTitle(state: TabsState, id: string, autoTitle: string): TabsState {
  const tabs = state.tabs.map((t): TerminalTab => (t.id === id ? { ...t, autoTitle } : t))
  return { ...state, tabs }
}

/** Mark an engine tab's PTY as having spawned (see `EngineTab.spawned`). */
export function markTabSpawned(state: TabsState, id: string): TabsState {
  const tabs = state.tabs.map(
    (t): TerminalTab => (t.id === id && t.kind === "engine" && !t.spawned ? { ...t, spawned: true } : t),
  )
  return { ...state, tabs }
}

/**
 * Rehydrate a persisted tab snapshot (issue #22). Command tabs are
 * transient by nature (an editor that quit, a degraded shell) — they are
 * dropped, engine tabs survive with their identity + sessionId so the
 * host can `--resume` them. Guards against a corrupt/empty snapshot by
 * falling back to `initialTabs()`; re-anchors `activeId` if it pointed
 * at a dropped tab.
 */
export function rehydrateTabs(persisted: TabsState): TabsState {
  const tabs = persisted.tabs.filter((t): t is EngineTab => t.kind === "engine")
  if (tabs.length === 0) return initialTabs()
  const activeId = tabs.some((t) => t.id === persisted.activeId) ? persisted.activeId : tabs[0].id
  const maxOrdinal = tabs.reduce((max, t) => Math.max(max, t.ordinal), 0)
  return { tabs, activeId, nextOrdinal: Math.max(persisted.nextOrdinal, maxOrdinal + 1) }
}

/** Cycle the active tab by ±1, wrapping at the ends. */
export function cycleTab(state: TabsState, delta: 1 | -1): TabsState {
  const n = state.tabs.length
  if (n <= 1) return state
  const i = state.tabs.findIndex((t) => t.id === state.activeId)
  const next = state.tabs[(i + delta + n) % n]
  return { ...state, activeId: next.id }
}

/** Switch directly to `id` (the tab strip's click target) — no-op if it isn't present. */
export function selectTab(state: TabsState, id: string): TabsState {
  return state.tabs.some((t) => t.id === id) ? { ...state, activeId: id } : state
}

/** Registry key for one tab's PTY — namespaced so tabs never collide. */
export function tabPtyKey(taskId: string, tabId: string): string {
  return `${taskId}::${tabId}`
}

/**
 * Registry key for one split leaf's PTY inside a tab (`TerminalSplit.tsx`
 * over the content-agnostic `split-core.ts`). `leaf-1` maps to the TAB
 * key itself so the PTY that existed before the first split is reused,
 * not respawned; later leaves namespace under it.
 */
export function splitLeafPtyKey(tabKey: string, leafId: string): string {
  return leafId === "leaf-1" ? tabKey : `${tabKey}::${leafId}`
}
