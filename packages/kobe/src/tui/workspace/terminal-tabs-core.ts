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
import { type SplitState, leaves } from "./split-core"

/**
 * A tab's frozen split layout — the content-agnostic tree (`split-core`)
 * with terminal-flavored leaf payloads: `null` = the tab's own engine
 * command (only `leaf-1`), an argv = a split-created shell. JSON-safe, so
 * it rides the persisted tab straight into state.json.
 */
export type PersistedSplit = SplitState<readonly string[] | null>

interface TabBase {
  /** Stable id — registry key suffix. Never reused within a task. */
  readonly id: string
  /** User title; null = untitled (view shows the numbered default). */
  readonly title: string | null
  /** 1-based creation ordinal — drives the "Tab {n}" default title. */
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
  /**
   * Frozen split layout for this tab (the "group"). Absent/null = unsplit
   * (the tab's own engine fills the whole body). Persisted WITH the tab so
   * the layout survives restart (owner ask 2026-07-06): `leaf-1` is the
   * tab's engine and resumes via the tab's sessionId exactly like an
   * unsplit tab; the other leaves are shells that respawn fresh. We freeze
   * the LAYOUT only — a shell the user ran `claude` inside comes back as a
   * shell, not a tracked/resumed session. Owned by `TerminalSplit`, mutated
   * through `setTabSplit`.
   */
  readonly splitTree?: PersistedSplit | null
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
  /** FileTree-owned singleton slot. Other command tabs remain independent. */
  readonly purpose?: "editor"
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

/**
 * Degrade an engine tab whose CLI exited into a plain shell tab. Exiting
 * the vendor CLI is an allowed action, not an error: the tab keeps
 * its identity (id/title/ordinal) and respawns
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

/**
 * Set an engine tab's spawned flag (see `EngineTab.spawned`). Identity-
 * stable when the value doesn't change. The `false` direction is the
 * restart-verification correction: `--session-id` creates NO transcript
 * until the first message, so a tab that spawned but never conversed
 * must NOT `--resume` on the next start (claude errors "no conversation
 * found" and the tab degrades to a shell).
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

/**
 * Argv for an engine tab's PTY spawn. `base` is the tab's engine command
 * (vendor-pinned or the task's); `live` is whether the tab's PTY currently
 * exists in the registry. No pinned session id → the bare command (codex/
 * custom vendors). A tab that already spawned but has NO live PTY (host
 * restart, degrade re-acquire) resumes its conversation; otherwise the id
 * is pinned fresh — the flag shapes ride `withClaudeSessionId`'s existing
 * per-vendor contract, verbatim from the component it was extracted from.
 */
export function engineTabArgv(tab: EngineTab, base: readonly string[], live: boolean): readonly string[] {
  if (!tab.sessionId) return base
  if (tab.spawned && !live) return [...base, "--resume", tab.sessionId]
  return [...base, "--session-id", tab.sessionId]
}

export type TabExitAction = "close" | "resume" | "degrade"

/**
 * Policy for the ACTIVE tab's process exiting. Command tabs close
 * themselves (editor quit, degraded shell exit). An engine tab found dead
 * ON ATTACH (host restart / park-sweep corpse) with a resumable session
 * gets ONE resume attempt — `resumeTried` is the per-tab one-shot guard,
 * so a `--resume` that itself dies degrades normally instead of
 * respawning forever. Every other engine exit degrades the tab to a
 * plain shell in place (exiting the vendor CLI is allowed, not an error).
 */
export function tabExitAction(tab: TerminalTab, deadOnAttach: boolean, resumeTried: boolean): TabExitAction {
  if (tab.kind === "command") return "close"
  if (deadOnAttach && !!tab.sessionId && tab.spawned && !resumeTried) return "resume"
  return "degrade"
}

/**
 * Rehydrate a persisted tab snapshot (issue #22). A tab is a TERMINAL
 * (owner model 2026-07-07): claude/an editor are just processes that ran
 * in it, so EVERY tab survives restart. Engine tabs keep their identity
 * + sessionId so the host can `--resume` the conversation; command tabs
 * (an engine degraded to a shell, a dead editor) come back running
 * `shell` — their old process is gone, and resurrecting a fresh engine
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

/** Cycle the active tab by ±1, wrapping at the ends. */
export function cycleTab(state: TabsState, delta: 1 | -1): TabsState {
  const n = state.tabs.length
  if (n <= 1) return state
  const i = state.tabs.findIndex((t) => t.id === state.activeId)
  const next = state.tabs[(i + delta + n) % n]
  return { ...state, activeId: next.id }
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

/**
 * Whether a tab still runs its own engine leaf (`leaf-1`) — false once
 * you've closed it inside a split and only split-created shells survive
 * (57e3a20a). Unsplit (no tree) always counts as having it. Callers that
 * treat an engine tab as having live turn activity (the turn-poll loop,
 * the tab-strip's turn chip) must gate on this too, or a closed engine
 * leaf leaves a stale poll flapping against its released PTY.
 */
export function hasEngineLeaf(tree: PersistedSplit | null | undefined): boolean {
  return !tree || leaves(tree.root).some((l) => l.id === "leaf-1")
}

/**
 * Whether a tab's frozen layout is ACTUALLY split (>1 leaf). Gates the
 * ctrl+w / F2 chord fall-through between `TerminalTabs` and
 * `TerminalSplit`: while split, the tab-level close/rename bindings
 * disable so the chords reach the leaf-level ones, and vice versa. A
 * single surviving non-leaf-1 shell is NOT split — tab-level chords apply.
 */
export function isTabSplit(tree: PersistedSplit | null | undefined): boolean {
  return tree ? leaves(tree.root).length > 1 : false
}

/**
 * Collapse rule for a structural split edit: a tree whose SOLE survivor
 * is `leaf-1` (the tab's own engine at the tab key) folds back to `null`
 * — the unsplit fast path. A sole surviving SHELL leaf must KEEP the
 * tree: the fast path would respawn the engine (`props.command` at the
 * tab key) over it. Doubles as the render predicate — a non-null result
 * means the tab renders via the tree, not the single-engine fast path.
 */
export function collapseSplit(next: PersistedSplit): PersistedSplit | null {
  const ls = leaves(next.root)
  return ls.length === 1 && ls[0]?.id === "leaf-1" ? null : next
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

/**
 * Display names for a split tab's leaves, id → name (owner semantics
 * 2026-07-06: the TAB is the "group"; each leaf carries its OWN name).
 * Naming flow mirrors tabs: a manual rename (`leaf.title`) always wins.
 *
 * The ENGINE leaf (`null` content = the tab's own command) reads the
 * conversation's first-prompt title (`engineTitle` — the tab's own
 * title/autoTitle, the same string the group/tab label shows), falling back
 * to the command basename ("claude"/"codex") before the first prompt lands.
 * Split SHELL leaves read their live foreground-process title (`liveTitles`
 * — the OSC 0/2 window-title escape the shell/program sets, same mechanism
 * a real terminal tab uses: "zsh" idle, "vim"/"htop" once you run one),
 * falling back to the generic "shell" before any title has landed yet.
 * Same-named defaults get a reading-order occurrence suffix ("shell",
 * "shell 2") so two untitled shells stay tellable apart. Manual titles (F2
 * rename) always win and are never suffixed.
 */
/** Generic default name for a split-created shell leaf (a bare shell has no
 *  meaningful program name). Shared so the corner tag and a collapsed tab's
 *  label agree. */
export const SHELL_LEAF_NAME = "shell"

export function splitLeafNames(
  leafList: readonly { id: string; title?: string | null; content: readonly string[] | null }[],
  tabCommand: readonly string[],
  engineTitle?: string | null,
  liveTitles?: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const basename = (argv: readonly string[] | null): string => {
    const head = (argv ?? tabCommand)[0] ?? ""
    const name = head.split("/").at(-1) ?? ""
    return name.length > 0 ? name : "?"
  }
  const seen = new Map<string, number>()
  const out = new Map<string, string>()
  for (const leaf of leafList) {
    if (leaf.title) {
      out.set(leaf.id, leaf.title)
      continue
    }
    // Engine leaf → first-prompt title, else its live foreground-process
    // title (a shell tab's leaf-1 runs zsh and can enter claude/vim — the
    // static command basename would freeze on "zsh"), else vendor basename;
    // split shell leaf → live title, else generic "shell". Both dedupe by
    // reading order.
    const name =
      leaf.content === null
        ? engineTitle || liveTitles?.get(leaf.id) || basename(leaf.content)
        : liveTitles?.get(leaf.id) || SHELL_LEAF_NAME
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    out.set(leaf.id, n === 1 ? name : `${name} ${n}`)
  }
  return out
}
