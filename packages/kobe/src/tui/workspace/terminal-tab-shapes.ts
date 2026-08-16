/**
 * The tab SHAPES — `TabBase` and the three `kind`-discriminated variants
 * that make up {@link TerminalTab}. Split out of `terminal-tabs-core.ts`
 * (which owns the pure state transitions) for the file-size cap, the same
 * way the split-tree and argv helpers already were; core re-exports these
 * so existing importers keep one entry point.
 *
 * Types only — no runtime code, so the core↔shapes pair is erased at build
 * time and can never become an import cycle.
 */

import type { VendorId } from "@/types/vendor"
import type { PersistedSplit } from "./terminal-tab-split"

export interface TabBase {
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
   * semantics.
   */
  readonly autoTitle?: string | null
  /**
   * Last live process title this tab reported (the OSC stream an engine
   * rewrites as the conversation moves on). RECORDED so surfaces that
   * render a tab they aren't hosting — the Inbox above all — show what the
   * tab is doing NOW instead of freezing on `autoTitle`, which is the
   * FIRST prompt's summary and never changes again.
   *
   * Display precedence puts the genuinely live title first and this right
   * behind it: `title ?? liveName ?? lastTitle ?? autoTitle ?? default`.
   */
  readonly lastTitle?: string | null
  /**
   * Live engine identity recorded off the process-tree probe (`lastTitle`'s
   * twin): a shell the user ran `claude` in IS an agent, and hosted PTYs
   * keep that process alive across TUI restarts — but the fresh process's
   * registry only knows attached PTYs, so without this record the sidebar
   * tree demoted such tabs to non-agents on every restart. Recorded for
   * tabs with a live title (= attached PTY, so absence of a vendor is
   * authoritative there); an unattached tab keeps its last known value
   * until the probe can answer again.
   */
  readonly liveVendor?: VendorId | null
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
 * Runs an interactive engine CLI inside the user's shell: the tab's PTY
 * spawns `$SHELL` and the engine command is TYPED into it as initial
 * input ({@link shellSpawn}), so exiting the vendor lands on a normal
 * shell prompt with the user's full rc context — no degrade transition.
 * The tab closes only when the wrapping shell itself exits.
 */
export interface EngineTab extends TabBase {
  readonly kind: "engine"
  /**
   * Engine PROTOCOL override for THIS tab only (chosen via
   * `chat.tab.chooseEngine`, or resolved from {@link command}). Undefined =
   * inherit the task's current engine, like every plain `chat.tab.new` tab.
   */
  readonly vendor?: VendorId
  /**
   * Raw launch command pinned on THIS tab (`send --tab new --command …`).
   * Wins over {@link vendor} at spawn; `vendor` then carries the protocol
   * kobe resolved for it. Named `engineCommand`, not `command`, because
   * {@link CommandTab} already owns `command` as a fixed argv — the tab
   * union would stop discriminating if both spelled it the same way.
   */
  readonly engineCommand?: string
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
  /**
   * Session id this tab FORKED from ("continue this chat in a new tab",
   * same worktree): the first spawn opens on that conversation's history
   * and immediately branches into this tab's own session, so parent and
   * child diverge instead of two processes fighting over one transcript.
   * Only the first spawn uses it — see `engineTabArgv`. Absent on an
   * ordinary tab, which starts blank.
   */
  readonly forkFrom?: string | null
  /**
   * Prompt typed into this tab on its FIRST spawn only — the cross-engine
   * handoff's context brief (`session-handoff.ts`). Distinct from the
   * task-level `initialPrompt` prop, which only ever reaches a task's
   * FIRST engine tab; a handoff opens a later tab, so the prompt has to
   * ride the tab itself.
   */
  readonly initialPrompt?: string | null
  /**
   * This tab is a VIEWPORT onto another task's first engine session — the
   * kanban "project chattab with its own worktree" placement: the story's
   * task owns the worktree/branch/session, and this tab in the PROJECT
   * workspace attaches to that session (`<ptyTask.id>::tab-1` key, the
   * task's worktree as cwd, engine activity attributed to the task).
   * Workspaces render one at a time, so the two views never attach
   * simultaneously. Absent on every ordinary tab.
   */
  readonly ptyTask?: { readonly id: string; readonly worktree: string }
}

/**
 * Runs a fixed one-off argv: an editor tab (the FileTree "open in
 * editor" flow, see `openEditorTab`) or the ctrl+e "shell" pick. Closes
 * itself (and releases its PTY) when its process exits — the PTY-world
 * equivalent of tmux closing an editor's transient window on quit.
 */
export interface CommandTab extends TabBase {
  readonly kind: "command"
  readonly command: readonly string[]
  /** FileTree-owned singleton slot. Other command tabs remain independent. */
  readonly purpose?: "editor"
}

/**
 * A read-only file view — the FileTree `d` action (issue #21): the preview
 * `<diff>`/`<code>` renderable, hosted as a tab instead of the removed
 * `kobe ops --preview` window. No PTY: it renders from a one-shot git read
 * (`loadPreviewData`), so it never spawns, resumes, or auto-closes on an
 * exit. Like the editor tab it's a FileTree-owned SINGLETON slot ({@link
 * openContentTab} replaces it in place), so repeatedly hitting `d` swaps the
 * one preview tab rather than piling up.
 */
export interface ContentTab extends TabBase {
  readonly kind: "content"
  /** Worktree-relative path being previewed. */
  readonly relPath: string
  /** Base ref for the vs-base (Branch scope) diff; absent = diff vs HEAD. */
  readonly base?: string
}

/**
 * Discriminated on `kind` so the illegal shapes (vendor+command on one
 * tab, close-on-exit without a command) cannot be represented.
 */
export type TerminalTab = EngineTab | CommandTab | ContentTab
