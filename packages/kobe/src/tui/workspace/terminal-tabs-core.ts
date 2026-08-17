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
import type { PersistedSplit } from "./terminal-tab-split"

// Split-tree + naming policy (PersistedSplit + the leaf predicates/keying/
// naming + tab display naming) moved to `./terminal-tab-split` for the
// file-size cap; re-exported here so existing importers keep one entry point.
export {
  type PersistedSplit,
  SHELL_LEAF_NAME,
  collapseSplit,
  hasEngineLeaf,
  isTabSplit,
  splitLeafNames,
  splitLeafPtyKey,
  tabTitle,
  tabTitleStable,
  visibleNativeStatus,
} from "./terminal-tab-split"

// Tab SHAPES (TabBase + EngineTab/CommandTab/ContentTab + the TerminalTab
// union) moved to `./terminal-tab-shapes` for the file-size cap; re-exported
// here so existing importers keep one entry point.
export type { CommandTab, ContentTab, EngineTab, TerminalTab } from "./terminal-tab-shapes"
import type { CommandTab, ContentTab, TerminalTab } from "./terminal-tab-shapes"

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

/** A SCRATCH task's initial state (issue #33): one bare shell tab, active —
 *  the task is the shell, an engine only appears when the user types one.
 *  Same shape the ctrl+e "shell" pick mints ({@link openCommandTab}). */
export function initialShellTabs(shell: string): TabsState {
  return {
    tabs: [{ kind: "command", id: "tab-1", title: null, ordinal: 1, command: [shell] }],
    activeId: "tab-1",
    nextOrdinal: 2,
  }
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
 * Open a one-off command tab after the active tab and focus it — the
 * PTY-world equivalent of tmux's `openInEditor` transient window
 * (`tmux/editor-launch.ts`): runs the already-resolved `command` (e.g.
 * `["sh", "-c", "nvim -d ..."]`), labeled `label` (the file's basename;
 * null lets the live foreground-process title name the tab — the ctrl+e
 * "shell" pick), and closes itself when the process exits (kind
 * "command", consumed by `TerminalTabs.tsx`'s `onExit` wiring).
 */
export function openCommandTab(state: TabsState, command: readonly string[], label: string | null): TabsState {
  const ordinal = state.nextOrdinal
  return insertAfterActive(state, { kind: "command", id: `tab-${ordinal}`, title: label, ordinal, command })
}

/** The FileTree-owned command tab, if this task already has one. */
export function findEditorTab(state: TabsState): CommandTab | undefined {
  return state.tabs.find((tab): tab is CommandTab => tab.kind === "command" && tab.purpose === "editor")
}

/**
 * Open or replace the one FileTree-owned editor tab. Its stable identity and
 * position make it a reusable File slot; callers restart its PTY when this
 * transition targets an existing tab.
 */
export function openEditorTab(state: TabsState, command: readonly string[], label: string): TabsState {
  const existing = findEditorTab(state)
  if (!existing) {
    const ordinal = state.nextOrdinal
    return insertAfterActive(state, {
      kind: "command",
      id: `tab-${ordinal}`,
      title: label,
      ordinal,
      command,
      purpose: "editor",
    })
  }
  const tabs = state.tabs.map(
    (tab): TerminalTab => (tab.id === existing.id ? { ...existing, title: label, command, splitTree: null } : tab),
  )
  return { ...state, tabs, activeId: existing.id }
}

/** The FileTree-owned read-only preview tab, if this task already has one. */
export function findContentTab(state: TabsState): ContentTab | undefined {
  return state.tabs.find((tab): tab is ContentTab => tab.kind === "content")
}

/**
 * Open or replace the one FileTree-owned read-only preview tab ({@link
 * ContentTab}) — the `d` action's singleton slot, mirroring {@link
 * openEditorTab}. First time: insert after the active tab and focus it. Later
 * hits: retarget the existing tab to the new file/base in place (its render
 * re-reads on the prop change) and select it. Selecting is a content swap,
 * not a focus grab — the FileTree keeps keyboard focus (KOB-25); the host
 * wires it without a `focus.setFocused`.
 */
export function openContentTab(state: TabsState, relPath: string, label: string, base?: string): TabsState {
  const existing = findContentTab(state)
  if (!existing) {
    const ordinal = state.nextOrdinal
    return insertAfterActive(state, { kind: "content", id: `tab-${ordinal}`, title: label, ordinal, relPath, base })
  }
  const tabs = state.tabs.map(
    (tab): TerminalTab => (tab.id === existing.id ? { ...existing, title: label, relPath, base } : tab),
  )
  return { ...state, tabs, activeId: existing.id }
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

/** Mark an engine tab as forked from `sourceSessionId` (see
 *  `EngineTab.forkFrom`). Same shape as {@link setTabSessionId}: the id
 *  comes from IO (the source tab's pin, or the engine's transcript store). */
export function setTabForkFrom(state: TabsState, id: string, sourceSessionId: string): TabsState {
  const tabs = state.tabs.map(
    (t): TerminalTab => (t.id === id && t.kind === "engine" ? { ...t, forkFrom: sourceSessionId } : t),
  )
  return { ...state, tabs }
}

/** Give an engine tab its own first-spawn prompt (see
 *  `EngineTab.initialPrompt`) — the cross-engine handoff brief. */
export function setTabInitialPrompt(state: TabsState, id: string, prompt: string): TabsState {
  const tabs = state.tabs.map(
    (t): TerminalTab => (t.id === id && t.kind === "engine" ? { ...t, initialPrompt: prompt } : t),
  )
  return { ...state, tabs }
}

/**
 * Record the tab's latest live process title. No-op when unchanged, so the
 * OSC stream (which repeats the same title on every turn) can call this
 * freely without churning the persisted snapshot.
 *
 * An EMPTY title is also a no-op: this field exists so surfaces that render
 * a tab they don't host still know its name, and "the process has not
 * reported a title" must never erase the one it reported earlier. Recording
 * `""` renamed a live session to its vendor default a beat after the real
 * title appeared (owner report 2026-08-10) — and persisted that, so the tab
 * came back wrong on the next start too.
 */
export function setTabLastTitle(state: TabsState, id: string, lastTitle: string): TabsState {
  if (lastTitle.length === 0) return state
  const current = state.tabs.find((t) => t.id === id)
  if (!current || current.lastTitle === lastTitle) return state
  const tabs = state.tabs.map((t): TerminalTab => (t.id === id ? { ...t, lastTitle } : t))
  return { ...state, tabs }
}

/**
 * Record the tab's live engine identity (see `TerminalTab.liveVendor`).
 * Same no-op contract as {@link setTabLastTitle} — the probe repeats the
 * same answer every tick.
 */
export function setTabLiveVendor(state: TabsState, id: string, liveVendor: VendorId | null): TabsState {
  const current = state.tabs.find((t) => t.id === id)
  if (!current || (current.liveVendor ?? null) === liveVendor) return state
  const tabs = state.tabs.map((t): TerminalTab => (t.id === id ? { ...t, liveVendor } : t))
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

/**
 * Set an engine tab's spawned flag (see `EngineTab.spawned`). Identity-
 * stable when the value doesn't change. The `false` direction is the
 * restart-verification correction: `--session-id` creates NO transcript
 * until the first message, so a tab that spawned but never conversed
 * must NOT `--resume` on the next start (claude errors "no conversation
 * found" and drops the user at the wrapping shell's prompt).
 */
export function setTabSpawned(state: TabsState, id: string, spawned: boolean): TabsState {
  const tabs = state.tabs.map(
    (t): TerminalTab => (t.id === id && t.kind === "engine" && !t.spawned !== !spawned ? { ...t, spawned } : t),
  )
  return { ...state, tabs }
}

/** Mark an engine tab's PTY as having spawned (see `EngineTab.spawned`). */
export function markTabSpawned(state: TabsState, id: string): TabsState {
  return setTabSpawned(state, id, true)
}

// Engine-tab argv/spawn composition moved to `./terminal-tab-argv` for the
// file-size cap; shell-wrapping helpers to `./terminal-tab-spawn`. Both are
// re-exported here so existing importers keep one entry point.
export { type TabExitAction, engineTabArgv, engineTabSpawnFor, tabExitAction } from "./terminal-tab-argv"
export { type TabSpawn, shellCommandLine, shellIdentityInput, shellSpawn } from "./terminal-tab-spawn"

/**
 * Rehydrate a persisted tab snapshot (issue #22). A tab is a TERMINAL
 * (owner model 2026-07-07): claude/an editor are just processes that ran
 * in it, so EVERY tab survives restart. Engine tabs keep their identity
 * + sessionId so the host can `--resume` the conversation; command tabs
 * (a shell pick, a dead editor) come back running `shell` — their old
 * process is gone, and resurrecting a fresh engine
 * in its place was the "closed shell reopens as claude" bug. Same
 * freeze-the-layout rule splitTree restore follows. Guards against a
 * corrupt/empty snapshot by falling back to `initialTabs()`; re-anchors
 * `activeId` if it pointed at a tab that no longer exists.
 */
export function rehydrateTabs(persisted: TabsState, shell: readonly string[]): TabsState {
  const tabs = persisted.tabs.map(
    (t): TerminalTab => (t.kind === "command" ? { ...t, command: shell, purpose: undefined } : t),
  )
  if (tabs.length === 0) return initialTabs()
  const activeId = tabs.some((t) => t.id === persisted.activeId) ? persisted.activeId : tabs[0].id
  const maxOrdinal = tabs.reduce((max, t) => Math.max(max, t.ordinal), 0)
  return { tabs, activeId, nextOrdinal: Math.max(persisted.nextOrdinal, maxOrdinal + 1) }
}

/**
 * Recycle-in-place state for the last tab's exit: a fresh engine tab
 * (new session, ordinal 1) that KEEPS the exited tab's name — user
 * `title` and `autoTitle` carry over, so the strip doesn't visibly
 * rename itself on every recycle. The carried autoTitle also blocks the
 * naming pass from deriving a new one (its `!title && !autoTitle`
 * self-limit), which was the "title changes every recycle" bug.
 */
export function recycleTabs(prev: TerminalTab): TabsState {
  const fresh = initialTabs()
  const tabs = [{ ...fresh.tabs[0], title: prev.title, autoTitle: prev.autoTitle }]
  return { ...fresh, tabs }
}

/** Cycle the active tab by ±1, wrapping at the ends. */
export function cycleTab(state: TabsState, delta: 1 | -1): TabsState {
  const n = state.tabs.length
  if (n <= 1) return state
  const i = state.tabs.findIndex((t) => t.id === state.activeId)
  const next = state.tabs[(i + delta + n) % n]
  return { ...state, activeId: next.id }
}

/**
 * Move a tab up/down within its task's tab list (sidebar move mode, issue
 * #43). Edge-stops — moving the first tab up or the last down returns the
 * SAME state object (no wrap), so callers persist nothing on a no-op. Tab
 * order IS the persisted `tabs` array order (`rehydrateTabs` keeps it), so
 * this needs no new persistence key.
 */
export function moveTab(state: TabsState, id: string, delta: -1 | 1): TabsState {
  const i = state.tabs.findIndex((t) => t.id === id)
  const j = i + delta
  if (i < 0 || j < 0 || j >= state.tabs.length) return state
  const tabs = [...state.tabs]
  const a = tabs[i] as TerminalTab
  tabs[i] = tabs[j] as TerminalTab
  tabs[j] = a
  return { ...state, tabs }
}

/** Switch directly to `id` (the tab strip's click target) — no-op if it
 *  isn't present OR is already active. The already-active guard matters:
 *  without it, clicking the current tab returned a NEW state object, which
 *  the component persisted (state.json write) and re-rendered — the same
 *  no-op-churn class as `focusLeaf`/`setTabSplit`. */
export function selectTab(state: TabsState, id: string): TabsState {
  if (state.activeId === id || !state.tabs.some((t) => t.id === id)) return state
  return { ...state, activeId: id }
}

/**
 * Set (or clear, with `null`) a tab's frozen split layout. Pure so vitest
 * pins the persistence round-trip; `TerminalSplit` calls it through the
 * component's `update` (which writes state.json), so every split / rename
 * / close inside the tree lands on disk and survives restart. Unknown ids
 * no-op.
 */
export function setTabSplit(state: TabsState, id: string, tree: PersistedSplit | null): TabsState {
  if (!state.tabs.some((t) => t.id === id)) return state
  const tabs = state.tabs.map((t): TerminalTab => (t.id === id ? { ...t, splitTree: tree } : t))
  return { ...state, tabs }
}

/** Registry key for one tab's PTY — namespaced so tabs never collide. */
export function tabPtyKey(taskId: string, tabId: string): string {
  return `${taskId}::${tabId}`
}

/** A tab's actual PTY key: a viewport tab (see {@link EngineTab.ptyTask})
 *  attaches to the referenced task's FIRST engine session; every other tab
 *  keys under its own task. */
export function tabPtyKeyFor(taskId: string, tab: TerminalTab): string {
  if (tab.kind === "engine" && tab.ptyTask) return tabPtyKey(tab.ptyTask.id, "tab-1")
  return tabPtyKey(taskId, tab.id)
}

/** A tab's PTY working directory: viewport tabs run in the referenced
 *  task's worktree, everything else in the host task's. */
export function tabCwdFor(tab: TerminalTab, taskWorktree: string): string {
  if (tab.kind === "engine" && tab.ptyTask) return tab.ptyTask.worktree
  return taskWorktree
}
