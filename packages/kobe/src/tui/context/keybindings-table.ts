/**
 * Central keybinding registry for kobe.
 *
 * Single source of truth for: which chords trigger which action and what
 * the help dialog (F1) + Tasks-pane footer legend display. Panes register
 * handlers by binding **id** (`bindByIds`) — they don't hardcode chord
 * strings. A future settings UI can edit `KobeKeymap` (in-memory or
 * persisted via KV) without any pane having to know.
 *
 * Hand-off contract:
 *   - `id` is stable. Tests + settings persistence key off it.
 *   - `keys` is the list of chords that register the action. The first
 *     entry is the canonical chord (the displayed cap when there is no
 *     `hint.keys` override). Multiple chords are common when a
 *     terminal delivers the same logical key as different byte sequences
 *     (`ctrl+k`/`alt+k`) or when several keys do the same thing
 *     (`j`/`down`).
 *   - `scope` says whether the binding is registered globally or only
 *     when a specific pane is focused. The pane that owns the scope
 *     calls `bindByIds(...)` with the same id → the chord(s) come from
 *     this table.
 *   - `hint` is cosmetic display metadata: a friendly pseudo-chord
 *     (`j/k`, `ctrl+hjkl`, etc.) read by the two hint consumers — the
 *     help dialog's (F1) primary cap and the Tasks-pane footer legend
 *     (`capOf`/`legendCap` in `lib/help-groups.ts`). `hint == null` means
 *     no friendly display override — the canonical chord shows instead.
 *   - `description` + `category` feed the help dialog (F1).
 *
 * Hint vs. chord:
 *   - Legends may show a collapsed pseudo-chord (e.g. "j/k" for four
 *     real chords or "1/2/3") — that's `hint.keys`. The actually
 *     registered chords stay in `keys` and remain individually testable.
 *
 * Re-binding a chord = mutate `keys` for the relevant id. Users do this
 * via `~/.kobe/settings/keybindings.yaml`, applied once at TUI boot by
 * `applyUserKeybindings()` (context/keybindings-user.ts), which mutates
 * this table in place. No pane code has to change because pane
 * registration goes through `bindByIds` and the help dialog / footer
 * legend render from the (already-overridden) rows.
 *
 * Cmd / Option / Ctrl on macOS — three different modifiers, three different
 * chord prefixes:
 *
 *   - `ctrl+X`  always works; ctrl+letter has stable C0 byte mappings that
 *     every terminal forwards to the TTY. Use this as the primary chord.
 *   - `alt+X`   is the Option key on macOS. Sends `ESC X` in legacy mode and
 *     opentui surfaces it as `evt.option = true`. Note: macOS launchers
 *     (Raycast, Karabiner, Alfred) often grab Option+digit globally before it
 *     reaches the terminal. Don't rely on alt-chords as the only path.
 *   - `cmd+X`   is the Command key on macOS. Default-config terminals
 *     (Terminal.app, iTerm2, Ghostty) handle Cmd+letter as an *application*
 *     shortcut and never forward it to the TTY — so a `cmd+X` binding is a
 *     no-op there. Terminals that *can* forward modifier keys (Kitty,
 *     iTerm2 with "Send Modifier Keys" enabled, Ghostty with `keybind`) do
 *     deliver Cmd+X as `evt.meta = true`, which our keymap layer surfaces
 *     as `cmd+X`. Register `cmd+X` alongside the primary `ctrl+X` so users
 *     on forwarding terminals get the chord they expect (and `cmd+X`
 *     doesn't get silently swallowed by the stdin reader for lack of a
 *     binding).
 *
 * The native workspace also registers `ctrl+q` while the sidebar is focused,
 * matching the tmux handover's two-stage detach shape: first ctrl+q returns to
 * Tasks, second ctrl+q exits the attached UI. Plain `q` remains the sidebar
 * quit-confirm shortcut.
 */

import { CHAT_BINDINGS } from "./keybindings-chat.ts"
import { FILES_BINDINGS } from "./keybindings-files.ts"
import { SIDEBAR_BINDINGS } from "./keybindings-sidebar.ts"

/** Pane scopes used to gate where a binding is active. */
export type KobeBindingScope = "global" | "sidebar" | "workspace" | "files" | "terminal"

/**
 * Friendly-chord display override, read by the help dialog (F1) and the
 * Tasks-pane footer legend (`capOf`/`legendCap` in `lib/help-groups.ts`).
 * Optional — without it the canonical first chord is displayed.
 */
export type KobeBindingHint = {
  /** Display string for the chord. May be a collapsed pseudo-chord (e.g. "j/k"). */
  keys: string
}

/** A single binding row. */
export type KobeBinding = {
  /** Stable identifier (tests + future settings persistence key off this). */
  id: string
  /** Where the binding is registered. */
  scope: KobeBindingScope
  /**
   * Chord(s) that fire this binding. First is canonical. Multiple chords
   * exist for terminal-byte-sequence variants and equivalent keys.
   * An empty array means "this row exists for documentation/hint purposes
   * only — no chord is registered here." (Used for composer-internal keys
   * that the textarea handles via `onKeyDown`, e.g. `chat.send`.)
   */
  keys: readonly string[]
  /** Second strokes reached through the configurable PureTUI prefix. */
  prefixKeys?: readonly string[]
  /** Help-dialog category (groups rows visually). */
  category: string
  /** Help-dialog description text. */
  description: string
  /** Friendly-chord display override. Omitted = the first chord in `keys` shows. */
  hint?: KobeBindingHint
}

/**
 * The full kobe keymap. Edit this table to rebind / rename / regroup.
 * Pane code reaches in via `chordsOf(id)` / `bindByIds({...})`; the help
 * dialog and the Tasks-pane footer legend render from this list.
 *
 * Order matters for help-dialog grouping (preserved within a category).
 */
export const KobeKeymap: readonly KobeBinding[] = [
  // ─── Global ───────────────────────────────────────────────────────────
  {
    id: "help.open",
    scope: "global",
    keys: ["f1"],
    category: "Global",
    description: "Show keybindings help",
    hint: { keys: "F1" },
  },
  {
    // Sidebar-only — single letter `n`. While focused on the chat
    // composer / files / terminal, `n` is just a letter you type;
    // ctrl+q jumps back to the sidebar where `n` opens the new-task
    // dialog. Avoids the muscle-memory-vs-typing collision the old
    // global `ctrl+n` had.
    id: "task.new",
    scope: "sidebar",
    keys: ["n"],
    category: "Sidebar",
    description: "New task",
    hint: { keys: "n" },
  },
  {
    id: "task.openEditor",
    scope: "global",
    keys: [],
    prefixKeys: ["o"],
    category: "Global",
    description: "Open active task worktree in editor",
  },
  {
    id: "settings.open",
    scope: "global",
    keys: [],
    prefixKeys: [","],
    category: "Global",
    description: "Open settings",
  },
  {
    // Sidebar shortcut — single letter `s` mirrors the n/q pattern
    // (plain keys when the tasks list is focused). `ctrl+,` still
    // works from anywhere as the modifier-prefixed equivalent.
    id: "settings.open.sidebar",
    scope: "sidebar",
    keys: ["s"],
    category: "Sidebar",
    description: "Open settings",
    hint: { keys: "s" },
  },
  {
    // Sidebar-only, like `task.new` — a sidebar-launched utility page, not
    // an anywhere-reachable surface like Settings, so no `ctrl+…` global
    // companion chord. NOT `w`/`e` — `keymap-slot-parity.test.ts` documents
    // those two as a free-key example for `sidebar.nav` override testing;
    // `x` avoids clobbering that.
    id: "worktrees.open.sidebar",
    scope: "sidebar",
    keys: ["x"],
    category: "Sidebar",
    description: "Open worktrees",
    hint: { keys: "x" },
  },
  {
    // Sidebar-only — single letter `q` opens the quit confirm. ctrl+q is
    // also registered here for the native workspace's tmux-like two-stage
    // detach: first ctrl+q returns focus to the sidebar, second ctrl+q exits
    // the attached native UI. Pressing q while in the composer just types q.
    id: "app.quit",
    scope: "sidebar",
    keys: ["q", "ctrl+q"],
    category: "Sidebar",
    description: "Quit (with confirm)",
    hint: { keys: "q" },
  },
  {
    // "Back to tasks" chord. Plain `q` (sidebar scope) actually quits;
    // ctrl+q is THE escape hatch out of any pane (direct-only again —
    // owner call 2026-07-11, same as the tab-management rows: too
    // load-bearing for a two-stroke prefix). Scope stays "workspace"
    // for override validation.
    id: "focus.sidebar",
    scope: "workspace",
    keys: ["ctrl+q"],
    category: "Workspace",
    description: "Back to sidebar (tasks)",
    hint: { keys: "ctrl+q" },
  },

  // ─── Navigation ───────────────────────────────────────────────────────
  {
    // Ctrl+hjkl — vim-style pane focus, with prefix h/j/k/l aliases. The
    // four chords map to panes by ordinal:
    //   ctrl+h → 1 = sidebar (TASKS)
    //   ctrl+j → 2 = workspace
    //   ctrl+k → 3 = files
    //   ctrl+l → 4 = terminal
    // Why hjkl and not 1234? ctrl+digit needs CSI-u (which iTerm2
    // doesn't fully support — ctrl+1 falls through to a bare `1`
    // byte) and alt+digit gets eaten by macOS launchers like Raycast.
    id: "focus.numeric",
    scope: "global",
    keys: ["ctrl+h", "ctrl+j", "ctrl+k", "ctrl+l"],
    prefixKeys: ["h", "j", "k", "l"],
    category: "Navigation",
    description: "Jump to pane (h=sidebar, j=workspace, k=files, l=terminal)",
    hint: { keys: "ctrl+hjkl" },
  },
  {
    // Pane cycle — walks the workspace host's panes in order
    // (sidebar → workspace → files → wrap). `f4` ONLY, everywhere:
    // it sits in RESERVED_GLOBAL_CHORDS (panes/terminal/keys-pure.ts) so
    // it fires identically from inside the embedded terminal — F2/F3/F5
    // already carry kobe's rename/split/reset vocabulary, F4 fills the row.
    // NOT `tab` (tried 2026-07-06, cut same day): the cycle path always
    // lands on the workspace terminal, which must keep tab as shell /
    // engine completion — so tab-cycling both trapped there every lap AND
    // typed a literal \t into the engine composer on arrival. NOT
    // `shift+tab` reverse either — that's claude's plan-mode chord. One
    // key, one meaning; forward-only (tmux `prefix o` shape), prev is
    // just f4 twice.
    id: "focus.next",
    scope: "global",
    keys: ["f4"],
    category: "Navigation",
    description: "Focus next pane (sidebar → workspace → files)",
    hint: { keys: "f4" },
  },
  {
    // Jump to the next task that needs attention (P0) — walks the sidebar
    // order to the next task whose daemon engine-state is permission_needed /
    // error (plus any unread needs_input/error mark) and selects it. `f7`
    // continues kobe's F-row (F2 rename / F3 split / F4 pane-cycle / F5 reset
    // / F6 zen) — the only chord tier that fires from inside the embedded
    // terminal without stealing an engine chord. NOT `ctrl+g`: that's the
    // engine/readline abort-editing chord, and reserving it ate the user's
    // ctrl+g inside claude — kobe must not swallow the engine's own keys.
    // In RESERVED_GLOBAL_CHORDS so it fires identically from inside the
    // embedded terminal, same tier as focus.next (f4) / zenToggle (f6).
    id: "attention.next",
    scope: "global",
    keys: ["f7"],
    category: "Navigation",
    description: "Jump to the next task waiting for input",
    hint: { keys: "f7" },
  },
  {
    // Zen toggle (issue #18, pure-tui shape) — hides the Files column;
    // the sidebar's ☯ ZEN chip is the click-based exit affordance, this is
    // the keyboard one. `f6` sits in RESERVED_GLOBAL_CHORDS (panes/terminal/
    // keys-pure.ts) so it fires identically from inside the embedded
    // terminal, continuing the F2 (rename) / F3 (split) / F4 (pane cycle) /
    // F5 (reset) row. NOT `tmux.layout.zenToggle` (space) — that's the
    // tmux-layer's separate display row, unrelated contract.
    id: "workspace.zenToggle",
    scope: "global",
    keys: ["f6"],
    category: "Navigation",
    description: "Toggle zen mode (hide the files column)",
    hint: { keys: "f6" },
  },
  {
    // Doc-only: the chord is registered inline in Chat.tsx (gated on
    // focused + streaming + no dialog). ESC no longer "detaches" focus
    // back to the sidebar — that pulled focus out from under the user
    // mid-edit. Use `ctrl+q` (`focus.sidebar`) for the explicit detach;
    // ESC in chat is reserved for interrupting the current turn.
    id: "chat.interrupt",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Interrupt current turn (esc while streaming)",
  },
  // ─── Sidebar + Tasks pane ─────────────────────────────────────────────
  // Moved to keybindings-sidebar.ts (file-size cap) — same entries, same
  // order, same live-binding contract (`kobe tasks` consumes these via
  // `bindByIds`, following user overrides).
  ...SIDEBAR_BINDINGS,

  // ─── Workspace (tmux) + Workspace (chat) ─────────────────────────────
  // Moved to keybindings-chat.ts (file-size cap) — same entries, same order.
  ...CHAT_BINDINGS,

  // ─── Files ────────────────────────────────────────────────────────────
  // Moved to keybindings-files.ts (file-size cap) — same entries, same order.
  ...FILES_BINDINGS,

  // ─── Terminal ─────────────────────────────────────────────────────────
  {
    id: "terminal.scroll-up",
    scope: "terminal",
    keys: ["ctrl+pageup"],
    category: "Terminal",
    description: "Scroll scrollback up",
    hint: { keys: "ctrl+pgup" },
  },
  {
    id: "terminal.scroll-down",
    scope: "terminal",
    keys: ["ctrl+pagedown"],
    category: "Terminal",
    description: "Scroll scrollback down",
  },
  {
    id: "terminal.reset",
    scope: "terminal",
    keys: ["f5"],
    category: "Terminal",
    description: "Reset terminal — kill the current shell and respawn",
    hint: { keys: "f5" },
  },
  // NOTE: The terminal pane's bare-key passthrough (every alphanumeric /
  // named key forwarded to the PTY) is intentionally NOT in this table.
  // Those aren't user-configurable shortcuts — they're terminal-pane
  // behavior that has to forward whatever the user types to the shell.

  // ─── Dialog (informational) ───────────────────────────────────────────
  {
    // Dialogs (DialogProvider, DialogConfirm, etc.) own their own escape
    // binding higher on the binding stack. We list this here for the
    // help dialog only — there's no global ESC handler anymore: ESC is
    // owned by DialogProvider (when a dialog is open) and Chat.tsx (when
    // chat is focused + streaming). Idle ESC is a no-op.
    id: "dialog.cancel",
    scope: "global",
    keys: [],
    category: "Dialog",
    description: "Close the top dialog (esc)",
  },
  {
    // New-task dialog sub-tab cycling. Chord is registered inside the
    // dialog's own useBindings (so it wins over the workspace
    // `chat.tab.cycle-*` bindings, which are gated off while a dialog
    // is on the stack). This entry is doc-only — help dialog and any
    // future settings UI render it from here.
    id: "dialog.newtask.tab.cycle",
    scope: "global",
    keys: [],
    category: "Dialog",
    description: "Switch New Task tab (Existing / New Repo)",
    hint: { keys: "ctrl+[/]" },
  },
] as const
