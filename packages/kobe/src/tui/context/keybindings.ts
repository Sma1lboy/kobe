/**
 * Central keybinding registry for kobe.
 *
 * Single source of truth for: which chords trigger which action, what the
 * help dialog displays, and what the status bar hints. Panes register
 * handlers by binding **id** (`bindByIds`) — they don't hardcode chord
 * strings. The status bar reads `KobeKeymap` directly. A future settings
 * UI can edit `KobeKeymap` (in-memory or persisted via KV) without any
 * pane having to know.
 *
 * Hand-off contract:
 *   - `id` is stable. Tests + settings persistence key off it.
 *   - `keys` is the list of chords that register the action. The first
 *     entry is the canonical chord (help dialog primary; status-bar hint
 *     when no `hint.keys` override). Multiple chords are common when a
 *     terminal delivers the same logical key as different byte sequences
 *     (`ctrl+k`/`alt+k`) or when several keys do the same thing
 *     (`j`/`down`).
 *   - `scope` says whether the binding is registered globally or only
 *     when a specific pane is focused. The pane that owns the scope
 *     calls `bindByIds(...)` with the same id → the chord(s) come from
 *     this table.
 *   - `hint` is cosmetic display metadata. Help uses it to print friendly
 *     pseudo-chords (`j/k`, `ctrl+hjkl`, etc.). The status bar also uses it
 *     unless `hint.status === false`. `hint.pin = "right"` keeps the hint
 *     in the always-visible right column; otherwise the hint shows only while
 *     its scope is focused. `hint == null` means no friendly display override.
 *   - `description` + `category` feed the help dialog (F1).
 *
 * Hint vs. chord:
 *   - The status bar may show a collapsed pseudo-chord (e.g. "j/k" for
 *     four real chords or "1/2/3") — that's `hint.keys`. The actually
 *     registered chords stay in `keys` and remain individually testable.
 *
 * Re-binding a chord = mutate `keys` for the relevant id. Users do this
 * via `~/.kobe/settings/keybindings.yaml`, applied once at TUI boot by
 * `applyUserKeybindings()` (context/keybindings-user.ts), which mutates
 * this table in place. No pane code has to change because pane
 * registration goes through `bindByIds` and the help dialog / status bar
 * render from the (already-overridden) rows.
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
 * Why `app.quit.keys` lists both `ctrl+shift+q` and `ctrl+q`: the keymap
 * layer (`src/tui/lib/keymap.tsx`) intentionally drops the shift modifier
 * on letter keys (terminals deliver shift+letter as uppercase, not as a
 * modifier event), so `ctrl+shift+q` and `ctrl+q` produce the same
 * candidate at match time. Listing both documents intent — the status-bar
 * hint advertises ctrl+shift+q (safer/harder to fat-finger) but the
 * actual byte path is ctrl+q.
 */

import { createSignal } from "solid-js"
import type { Binding } from "../lib/keymap"

/** Pane scopes used to gate where a binding is active. */
export type KobeBindingScope = "global" | "sidebar" | "workspace" | "files" | "terminal"

/** Status-bar hint metadata. Optional — bindings without a hint don't show in the bar. */
export type KobeBindingHint = {
  /** Display string for the chord. May be a collapsed pseudo-chord (e.g. "j/k"). */
  keys: string
  /** Short verb/noun shown next to the chord (e.g. "nav", "delete"). */
  label: string
  /**
   * `false` keeps the friendly chord in Help while suppressing it from the
   * bottom status bar. Use for low-frequency, destructive, or state-specific
   * actions that should not crowd small terminals.
   */
  status?: false
  /**
   * `"right"` keeps the hint in the always-visible right column of the
   * status bar (global / cross-pane reminders like quit, help, new).
   * Omitted = pane-local hint, only shown when the binding's scope is
   * focused.
   */
  pin?: "right"
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
  /** Help-dialog category (groups rows visually). */
  category: string
  /** Help-dialog description text. */
  description: string
  /** Status-bar hint config. Omitted = not shown in status bar. */
  hint?: KobeBindingHint
}

/**
 * The full kobe keymap. Edit this table to rebind / rename / regroup.
 * Pane code reaches in via `chordsOf(id)` / `bindByIds({...})`; the help
 * dialog and status bar both render from this list.
 *
 * Order matters for help-dialog grouping (preserved within a category)
 * and for status-bar hint display order (left column left-to-right).
 */
export const KobeKeymap: readonly KobeBinding[] = [
  // ─── Global ───────────────────────────────────────────────────────────
  {
    id: "help.open",
    scope: "global",
    keys: ["f1"],
    category: "Global",
    description: "Show keybindings help",
    hint: { keys: "F1", label: "help", pin: "right" },
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
    hint: { keys: "n", label: "new" },
  },
  {
    id: "task.openEditor",
    scope: "global",
    keys: ["ctrl+o"],
    category: "Global",
    description: "Open active task worktree in editor",
  },
  {
    id: "settings.open",
    scope: "global",
    keys: ["ctrl+,"],
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
    hint: { keys: "s", label: "settings", status: false },
  },
  {
    // Sidebar-only — single letter `q`. ctrl+q is reserved for
    // "back to sidebar" (focus.sidebar) so the user has a one-chord
    // path out of the composer; once back on the sidebar, `q` is the
    // quit verb. Pressing q while in the composer just types a `q`.
    id: "app.quit",
    scope: "sidebar",
    keys: ["q"],
    category: "Sidebar",
    description: "Quit (with confirm)",
    hint: { keys: "q", label: "quit", status: false },
  },
  {
    // Workspace-only "back to tasks" chord. Plain `q` (sidebar
    // scope) actually quits; ctrl+q is the chord-form aliased to
    // sidebar focus, mirroring esc / ctrl+1 in effect.
    id: "focus.sidebar",
    scope: "workspace",
    keys: ["ctrl+q"],
    category: "Workspace",
    description: "Back to sidebar (tasks)",
    hint: { keys: "ctrl+q", label: "tasks" },
  },

  // ─── Navigation ───────────────────────────────────────────────────────
  {
    // `ctrl+hjkl` — vim-style direct pane focus. Reliable across
    // every terminal (ctrl+letter maps to stable C0 control bytes,
    // no CSI-u / kitty keyboard / iTerm quirks). The four chords
    // map to the four panes by ordinal:
    //   ctrl+h → 1 = sidebar (TASKS)
    //   ctrl+j → 2 = workspace
    //   ctrl+k → 3 = files
    //   ctrl+l → 4 = terminal
    // Why hjkl and not 1234? ctrl+digit needs CSI-u (which iTerm2
    // doesn't fully support — ctrl+1 falls through to a bare `1`
    // byte) and alt+digit gets eaten by macOS launchers like
    // Raycast. ctrl+letter just works. The conflict with composer
    // editing chords (ctrl+h=backspace etc.) is OK in practice
    // because the user's intent when pressing ctrl+h is "switch
    // pane," and once focus moves to sidebar the textarea has
    // already lost focus.
    id: "focus.numeric",
    scope: "global",
    keys: ["ctrl+h", "ctrl+j", "ctrl+k", "ctrl+l"],
    category: "Navigation",
    description: "Jump to pane (h=sidebar, j=workspace, k=files, l=terminal)",
    hint: { keys: "ctrl+hjkl", label: "focus", pin: "right", status: false },
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
  // ─── Sidebar ──────────────────────────────────────────────────────────
  {
    // POSITIONAL: alternating [down, up] pairs — slot dispatch
    // (SLOT_CONTRACTS in lib/keymap-overrides.ts). Overrides may supply
    // any even chord count, e.g. `sidebar.nav: [w, s]`.
    id: "sidebar.nav",
    scope: "sidebar",
    keys: ["j", "k", "down", "up"],
    category: "Sidebar",
    description: "Move cursor up/down",
    hint: { keys: "j/k", label: "nav" },
  },
  {
    id: "sidebar.select",
    scope: "sidebar",
    keys: ["return"],
    category: "Sidebar",
    description: "Open the selected task",
    hint: { keys: "enter", label: "select" },
  },
  {
    id: "sidebar.goto",
    scope: "sidebar",
    keys: ["g"],
    category: "Sidebar",
    description: "Top / bottom of list (gg or shift-G)",
  },
  {
    id: "sidebar.rename",
    scope: "sidebar",
    keys: ["r"],
    category: "Sidebar",
    description: "Rename task",
    hint: { keys: "r", label: "rename", status: false },
  },
  {
    id: "sidebar.archive",
    scope: "sidebar",
    keys: ["a"],
    category: "Sidebar",
    description: "Toggle archive",
    hint: { keys: "a", label: "archive", status: false },
  },
  {
    id: "sidebar.localMerge",
    scope: "sidebar",
    keys: ["m"],
    category: "Sidebar",
    description: "Local merge task into parent repo (Shift+M)",
    hint: { keys: "M", label: "merge", status: false },
  },
  {
    // Capital P pins / unpins a regular task. Lowercase `p` falls
    // through to a no-op (the handler gates on evt.shift) so a
    // mistyped lowercase doesn't churn the flag. Pinned regular tasks
    // float to the top of the sidebar's flat list, just below the
    // saved-repo "main" rows. `kind: "main"` rows ignore the chord —
    // they're implicitly pinned.
    id: "sidebar.pin",
    scope: "sidebar",
    keys: ["p"],
    category: "Sidebar",
    description: "Pin / unpin task at top (Shift+P)",
    hint: { keys: "P", label: "pin", status: false },
  },
  {
    // POSITIONAL: [previous view, next view] pairs (slot dispatch).
    id: "sidebar.view",
    scope: "sidebar",
    keys: ["[", "]"],
    category: "Sidebar",
    description: "Switch view (Working session ↔ Archives)",
    hint: { keys: "[/]", label: "view", status: false },
  },
  {
    id: "sidebar.sort",
    scope: "sidebar",
    keys: ["t"],
    category: "Sidebar",
    description: "Switch task sort (default ↔ recent)",
    hint: { keys: "t", label: "sort", status: false },
  },
  {
    id: "sidebar.delete",
    scope: "sidebar",
    keys: ["d"],
    category: "Sidebar",
    description: "Delete task (with confirm)",
    hint: { keys: "d", label: "delete", status: false },
  },
  {
    // `/`-search filter. Enters an inline search mode rendered at the
    // top of the sidebar: typed text fuzz-matches against task title +
    // repo basename, up/down navigates the filtered list, enter selects
    // + exits, esc cancels + restores. While search is active the
    // single-letter sidebar chords (j/k/g/G/d/a/r/P/m) are
    // de-registered so they fall through to the input as literal text.
    // `[` / `]` view switch keeps working so the user can search inside
    // Archives.
    id: "sidebar.search.enter",
    scope: "sidebar",
    keys: ["/"],
    category: "Sidebar",
    description: "Search tasks (fuzzy filter)",
    hint: { keys: "/", label: "search" },
  },
  {
    // Search-mode nav. Only fires while the search input is focused —
    // j/k are intentionally NOT bound here so they reach the input.
    // POSITIONAL: [down, up] pairs (slot dispatch).
    id: "sidebar.search.nav",
    scope: "sidebar",
    keys: ["down", "up"],
    category: "Sidebar",
    description: "Move highlight in search results",
  },
  {
    // Search-mode submit: select highlighted match and leave search.
    id: "sidebar.search.submit",
    scope: "sidebar",
    keys: ["return"],
    category: "Sidebar",
    description: "Select search match and exit search",
  },
  {
    // Search-mode cancel. Only registered while searching; outside
    // search there is no sidebar-scope esc handler.
    id: "sidebar.search.cancel",
    scope: "sidebar",
    keys: ["escape"],
    category: "Sidebar",
    description: "Cancel search (restore prior selection)",
  },

  // ─── Tasks pane ───────────────────────────────────────────────────────
  // The standalone Tasks pane (`kobe tasks`, src/tui/tasks-pane/host.tsx)
  // consumes these ids via `bindByIds` (since the keybindings-customization
  // pass; they were raw `{ key: "…" }` literals before), so the rows are
  // LIVE bindings there and follow user overrides from
  // `~/.kobe/settings/keybindings.yaml`. New-task (n), settings (s),
  // rename (r), archive (a), delete (d), merge (M), views ([/]), sort (t)
  // are already covered by the Sidebar / Global rows above and aren't
  // duplicated here.
  {
    id: "tasks.openWorktree",
    scope: "sidebar",
    keys: ["o"],
    category: "Tasks pane",
    description: "Open selected task's worktree in your editor",
    hint: { keys: "o", label: "open wt", status: false },
  },
  {
    id: "tasks.renameBranch",
    scope: "sidebar",
    keys: ["b"],
    category: "Tasks pane",
    description: "Rename the selected task's git branch",
    hint: { keys: "b", label: "branch", status: false },
  },
  {
    id: "tasks.cycleEngine",
    scope: "sidebar",
    keys: ["v"],
    category: "Tasks pane",
    description: "Cycle engine vendor (claude ↔ codex ↔ …) — applies on reopen",
    hint: { keys: "v", label: "engine", status: false },
  },
  {
    id: "tasks.update",
    scope: "sidebar",
    keys: ["u"],
    category: "Tasks pane",
    description: "Open the update page (when a new version is available)",
    hint: { keys: "u", label: "update", status: false },
  },
  {
    // `?` (shift+/ — terminals deliver the literal character) folds the
    // Tasks pane's `── keys ──` legend down to its header line and back.
    // The legend is ~20 rows tall with the tmux session chords included;
    // on short terminals it crowds out the task list. The collapsed state
    // persists via KV so the preference survives pane respawns.
    id: "tasks.toggleKeys",
    scope: "sidebar",
    keys: ["?"],
    category: "Tasks pane",
    description: "Collapse / expand the keys legend",
    hint: { keys: "?", label: "fold keys", status: false },
  },

  // ─── Workspace (tmux) ─────────────────────────────────────────────────
  // tmux-handover chords that drive the task SESSION (windows/tabs/detach),
  // not opentui bindings. Listed here so the HelpDialog advertises them; the
  // bracket / ctrl rows below in "Workspace (chat)" register the real opentui
  // handlers, while the `prefix f` quick-task is a tmux key-table binding the
  // session installs (not registered through this keymap at all) — DISPLAY
  // ONLY, with `keys: []` so nothing tries to bind a literal "prefix f" chord.
  {
    id: "tmux.quickTask",
    scope: "global",
    keys: [],
    category: "Workspace (tmux)",
    description: "Quick new task (tmux prefix, then f)",
    hint: { keys: "prefix f", label: "new task", status: false },
  },
  {
    id: "tmux.engineTab",
    scope: "global",
    keys: [],
    category: "Workspace (tmux)",
    description: "Open the engine in a new tab (tmux prefix, then t)",
    hint: { keys: "prefix t", label: "engine tab", status: false },
  },

  // ─── Workspace (chat) ─────────────────────────────────────────────────
  {
    // Composer textarea handles enter via its own onKeyDown. This row
    // exists only for help-dialog + status-bar visibility; no chord is
    // registered here.
    id: "chat.send",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Send message (composer)",
    hint: { keys: "enter", label: "send" },
  },
  {
    // Composer textarea inserts a literal newline on shift+enter (kitty/
    // CSI-u terminals) and ctrl+J everywhere else; no chord is registered
    // here. Surfaced in the status bar so the user doesn't have to memorize
    // it after we stripped the inline footer hint from the composer.
    id: "chat.newline",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Newline in composer",
    hint: { keys: "shift+enter", label: "newline" },
  },
  {
    // Shift+tab inside the composer cycles the per-task permission mode
    // (default ↔ plan); the chord is registered in
    // Composer's onKeyDown, not here. Doc-only entry so the status bar
    // advertises the binding to a focused user.
    id: "chat.cycle-mode",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Cycle permission mode (composer)",
    hint: { keys: "shift+tab", label: "mode" },
  },
  {
    // Ctrl+enter mid-stream interrupts the in-flight subprocess and
    // dispatches the new buffer immediately. Plain enter while
    // streaming queues instead. Chord is registered in Composer's
    // onKeyDown; this entry is doc-only.
    id: "chat.steer",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Steer (interrupt + send) — mid-stream only",
    hint: { keys: "ctrl+enter", label: "steer", status: false },
  },
  {
    id: "chat.tab.new",
    scope: "workspace",
    keys: ["ctrl+t"],
    category: "Workspace",
    description: "New chat tab",
    hint: { keys: "ctrl+t", label: "new tab" },
  },
  {
    // KOB-74. Quick-fork: from a focused chat tab, spin up a child
    // task that inherits repo + branch + model from the source. The
    // dialog asks only for a prompt; the fork's first turn fires
    // immediately. `ctrl+t` is taken by `chat.tab.new` (same task,
    // new tab) so the requested `ctrl+shift+t` would collide — the
    // keymap layer drops `shift+` on letter keys (terminals deliver
    // shift+letter as uppercase, not as a modifier event), making
    // `ctrl+shift+t` and `ctrl+t` indistinguishable at match time.
    // Picked `ctrl+f` ("fork") because it's free across the keymap,
    // ctrl+letter has stable C0 byte mappings that work in every
    // terminal, and the workspace scope keeps it from intruding on
    // other panes. See docs/KEYBINDINGS.md decision log.
    id: "chat.fork.new",
    scope: "workspace",
    keys: ["ctrl+f"],
    category: "Workspace",
    description: "Quick-fork: create child task seeded with current repo/branch/model",
    hint: { keys: "ctrl+f", label: "fork" },
  },
  {
    // Mirror of claude-code's `/resume` slash. Pops a picker listing
    // every persisted session for the active task's worktree so the
    // user can jump back to (or fork from) any prior conversation.
    // Selecting an already-open session focuses its tab; otherwise a
    // new tab is opened seeded with that sessionId. Chord chosen for
    // mnemonic "yank from history" — `ctrl+r` belongs to the prompt
    // history palette (claude-code parity, KOB-154) and `ctrl+h`
    // collides with terminals' backspace byte.
    id: "chat.session.resume",
    scope: "workspace",
    keys: ["ctrl+y"],
    category: "Workspace",
    description: "Resume a prior session in this task's worktree",
    hint: { keys: "ctrl+y", label: "resume", status: false },
  },
  {
    id: "chat.tab.close",
    scope: "workspace",
    keys: ["ctrl+w"],
    category: "Workspace",
    description: "Close chat tab",
    hint: { keys: "ctrl+w", label: "close tab", status: false },
  },
  {
    // Rename the active chat tab. F2 is the cross-OS / cross-IDE
    // rename convention (file managers on Windows + Linux, IntelliJ,
    // VS Code etc.) — chosen here because `ctrl+r` is owned by the
    // composer's prompt-history palette (claude-code parity, KOB-154
    // → KOB-156). F2 has no other binding in kobe and doesn't
    // collide with terminal bytes the way some control chords do.
    id: "chat.tab.rename",
    scope: "workspace",
    keys: ["f2"],
    category: "Workspace",
    description: "Rename active chat tab",
    hint: { keys: "f2", label: "rename tab", status: false },
  },
  {
    // `ctrl+]` cycles forward, `ctrl+[` cycles backward — bracket
    // pair mirrors the sidebar's `[/]` view switcher and the files
    // pane's `[/]` tab cycler so the bracket-pair pattern is
    // consistent across panes. The earlier `ctrl+tab` /
    // `ctrl+shift+tab` chord is dropped: `tab` is the global
    // pane-cycle (focus.next) and the ctrl-prefixed variant felt
    // collision-prone.
    id: "chat.tab.cycle-next",
    scope: "workspace",
    keys: ["ctrl+]"],
    category: "Workspace",
    description: "Next chat tab",
    hint: { keys: "ctrl+]", label: "next tab", status: false },
  },
  {
    id: "chat.tab.cycle-prev",
    scope: "workspace",
    keys: ["ctrl+["],
    category: "Workspace",
    description: "Previous chat tab",
    hint: { keys: "ctrl+[", label: "prev tab", status: false },
  },
  // AskUserQuestion picker bindings — only fire when a question card is
  // up (QuestionRow gates `enabled` on its own state). j/k/space/enter/
  // 1-9 are bare-letter chords by intent: while a picker is showing, the
  // composer is hidden (Chat.tsx `<Show when={!pendingQuestion()}>`) so
  // these never compete with composer typing. Workspace scope means the
  // chat pane must own focus — the user can still navigate the file tree
  // with j/k while a question is queued.
  //
  // NOTE: with the tmux-native model the legacy Chat pane (and its
  // QuestionRow) is gone, so these rows currently have NO live
  // registration site — they're display-only. `chat.question.nav` /
  // `chat.question.pick-number` stay in FIXED_BINDING_IDS for that
  // reason: an override would change Help copy without changing
  // behavior. If the picker returns, implement its nav with slot
  // dispatch (see sidebar.nav) before unlocking them.
  {
    id: "chat.question.nav",
    scope: "workspace",
    keys: ["j", "k", "down", "up"],
    category: "Workspace",
    description: "Move highlight in question picker",
    hint: { keys: "j/k", label: "pick", status: false },
  },
  {
    id: "chat.question.toggle",
    scope: "workspace",
    keys: ["space"],
    category: "Workspace",
    description: "Toggle highlighted option in question picker",
    hint: { keys: "space", label: "toggle", status: false },
  },
  {
    id: "chat.question.submit",
    scope: "workspace",
    keys: ["return"],
    category: "Workspace",
    description: "Advance / submit question picker",
    hint: { keys: "enter", label: "submit", status: false },
  },
  {
    id: "chat.question.pick-number",
    scope: "workspace",
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    category: "Workspace",
    description: "Pick option by number in question picker",
    hint: { keys: "1-9", label: "pick", status: false },
  },

  // ─── Files ────────────────────────────────────────────────────────────
  {
    // POSITIONAL: alternating [down, up] pairs (slot dispatch).
    id: "files.nav",
    scope: "files",
    keys: ["j", "k", "down", "up"],
    category: "Files",
    description: "Move cursor up/down",
    hint: { keys: "j/k", label: "nav" },
  },
  {
    // `h`/`l` for hierarchy navigation in the All tab tree:
    //   l → expand directory / descend into first child / open file
    //   h → collapse directory / jump to parent
    // Plain letters are pane-scoped per the keybinding-boundaries
    // rule (docs/KEYBINDINGS.md): files-focused only, so they don't
    // collide with composer typing.
    // POSITIONAL: alternating [collapse, expand] pairs (slot dispatch).
    id: "files.hierarchy",
    scope: "files",
    keys: ["h", "l", "left", "right"],
    category: "Files",
    description: "Collapse / expand tree level",
    hint: { keys: "h/l", label: "level" },
  },
  {
    // enter → one-key "just open it": opens the file in the user's
    // nvim/vim (side-by-side `nvim -d` diff vs HEAD when changed, a plain
    // editable open otherwise), falling back to our own opentui read-only
    // preview only when no nvim/vim is installed.
    id: "files.open",
    scope: "files",
    keys: ["return"],
    category: "Files",
    description: "Open file in nvim (diff vs HEAD when changed)",
    hint: { keys: "enter", label: "open" },
  },
  {
    // `[` / `]` cycle the All / Changes tabs. Bracket pair matches
    // the sidebar's Working/Archives view-switcher so the muscle
    // memory is consistent across panes.
    // POSITIONAL: [previous tab, next tab] pairs (slot dispatch).
    id: "files.tab",
    scope: "files",
    keys: ["[", "]"],
    category: "Files",
    description: "Switch tab (cycle All / Changes)",
    hint: { keys: "[/]", label: "tab", status: false },
  },
  {
    id: "files.refresh",
    scope: "files",
    keys: ["r"],
    category: "Files",
    description: "Refresh",
    hint: { keys: "r", label: "refresh", status: false },
  },
  {
    id: "files.openExternal",
    scope: "files",
    keys: ["o"],
    category: "Files",
    description: "Open file in system default app (audio / video / pdf preview)",
    hint: { keys: "o", label: "open external", status: false },
  },
  {
    // `a` → inject `@<path>` into the engine (claude/codex) pane via
    // tmux send-keys (KOB-232). Enter stays the full-width preview; this
    // is the "add as a mention" action. Plain letter, files-scoped per
    // the keybinding-boundaries rule, so it can't collide elsewhere.
    id: "files.mention",
    scope: "files",
    keys: ["a"],
    category: "Files",
    description: "Inject @<path> mention into the engine pane",
    hint: { keys: "a", label: "@mention" },
  },
  {
    // Ops-pane action on the Changes tab. This is the v0.5 Create PR
    // button rehomed into the file-changes surface: pressing `p` sends
    // the PR prompt into the engine pane instead of rendering an outer
    // monitor button.
    id: "files.createPR",
    scope: "files",
    keys: ["p"],
    category: "Files",
    description: "Create PR from the current task",
    hint: { keys: "p", label: "create PR" },
  },

  // ─── Terminal ─────────────────────────────────────────────────────────
  {
    id: "terminal.scroll-up",
    scope: "terminal",
    keys: ["ctrl+pageup"],
    category: "Terminal",
    description: "Scroll scrollback up",
    hint: { keys: "ctrl+pgup", label: "scroll", status: false },
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
    hint: { keys: "f5", label: "reset" },
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
    hint: { keys: "ctrl+[/]", label: "tab" },
  },
] as const

/**
 * Pristine snapshot of every row's overridable fields (`keys` + `hint`),
 * captured at module load BEFORE any `applyKeymapOverrides` mutation. The
 * live-reload path ({@link resetKeymapToDefaults}) restores from this so a
 * removed override returns to its default — additive in-place mutation
 * alone can't "un-override" a row.
 */
const KEYMAP_DEFAULTS: ReadonlyMap<string, { keys: readonly string[]; hint?: KobeBindingHint }> = new Map(
  KobeKeymap.map((b) => [b.id, { keys: [...b.keys], hint: b.hint ? { ...b.hint } : undefined }]),
)

/**
 * Restore every `KobeKeymap` row to its boot-time default chords + hint.
 * Called before re-applying the (re-read) keybindings file on a live
 * reload, so the net effect is "defaults + current overrides", never a
 * pile-up of stale overrides. Mutates in place — the same cast
 * `applyKeymapOverrides` uses, since the rows are runtime-mutable despite
 * the `readonly` types.
 */
export function resetKeymapToDefaults(): void {
  for (const row of KobeKeymap) {
    const def = KEYMAP_DEFAULTS.get(row.id)
    if (!def) continue
    const mutable = row as { keys: readonly string[]; hint?: KobeBindingHint }
    mutable.keys = [...def.keys]
    mutable.hint = def.hint ? { ...def.hint } : undefined
  }
}

/**
 * A bump-only reactive token: every live keymap reload increments it. The
 * chord LEGENDS (Tasks-pane footer, status bar) read it so they re-render
 * after a reload — the keymap array itself isn't a Solid store, so a
 * mutation is otherwise invisible to the renderer. Behaviour doesn't need
 * it (the dispatcher re-reads chords on every keypress); this is purely the
 * display nudge.
 */
const [keymapVersion, setKeymapVersion] = createSignal(0)
export { keymapVersion }

/** Increment {@link keymapVersion}, forcing chord legends to re-render. */
export function bumpKeymapVersion(): void {
  setKeymapVersion((v) => v + 1)
}

/**
 * id → row index. Safe to build once: `KobeKeymap` rows are mutated in
 * place by overrides (`keys` / `hint` fields change) but never added,
 * removed, or replaced, so the row identities the map holds stay
 * canonical forever. This keeps `findBinding` O(1) — it runs per id per
 * registered binding group on EVERY keypress (`useBindings` configs call
 * `bindByIds` on each dispatch), where the previous linear scan cost
 * ~60 row comparisons per id (~1.4k per keypress at a realistic
 * 5-group / 23-id stack).
 */
const KEYMAP_BY_ID: ReadonlyMap<string, KobeBinding> = new Map(KobeKeymap.map((b) => [b.id, b]))

/** Lookup helper used by tests and pane registration. */
export function findBinding(id: string): KobeBinding | undefined {
  return KEYMAP_BY_ID.get(id)
}

/**
 * Resolve the chord list for a binding id. Returns an empty array if the
 * id isn't found — `bindByIds` warns but doesn't throw, so a typo doesn't
 * crash the renderer.
 */
export function chordsOf(id: string): readonly string[] {
  return findBinding(id)?.keys ?? []
}

/** All bindings whose `scope` matches. */
export function bindingsForScope(scope: KobeBindingScope): KobeBinding[] {
  return KobeKeymap.filter((b) => b.scope === scope)
}

/**
 * Build a list of `Binding` (chord → handler) entries from a map of
 * `binding-id → handler`. Each id's chords from `KobeKeymap` get
 * registered against the same handler. Pane code uses this so it doesn't
 * have to know the chord strings — those live in `KobeKeymap`.
 *
 * Each entry carries `slot` = the chord's index within the id's (possibly
 * user-overridden) `keys` array, and the dispatcher passes it to the
 * handler as a second argument. Multiplexed handlers (`sidebar.nav`,
 * `files.hierarchy`, …) decide direction from the slot instead of
 * `evt.name`, which is what lets users rebind those ids: the slot LAYOUT
 * is the per-id positional contract (`SLOT_CONTRACTS` in
 * keymap-overrides.ts validates override counts against it). Because the
 * `useBindings` config closure re-runs `bindByIds` on every keypress,
 * slots are always derived from the CURRENT keymap — a live keybindings
 * reload re-slots automatically.
 *
 * Unknown ids log a warning and are skipped (typos shouldn't crash the
 * UI, but they should be loud in dev).
 */
export function bindByIds(handlers: Record<string, Binding["cmd"]>): Binding[] {
  const out: Binding[] = []
  for (const id in handlers) {
    const cmd = handlers[id]
    if (!cmd) continue
    const chords = chordsOf(id)
    if (chords.length === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[kobe/keybindings] bindByIds: id="${id}" has no chords (or doesn't exist in KobeKeymap)`)
      continue
    }
    chords.forEach((c, slot) => out.push({ key: c, cmd, slot }))
  }
  return out
}
