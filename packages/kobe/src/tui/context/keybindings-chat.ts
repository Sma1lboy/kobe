/**
 * `chat.*` (Workspace) + `tmux.*` (Workspace tmux-handover, display-only)
 * keybinding rows — split out of `keybindings.ts` (which was over the
 * repo's 500-line file-size cap) purely mechanically: same entries, same
 * order (`tmux.*` first, matching the original file — help-dialog's
 * `groupBindings` groups by first-encounter `category` order in the
 * flattened `KobeKeymap` array), moved verbatim. See `keybindings.ts`'s
 * doc comment for the full contract (id stability, scope semantics, hint
 * display rules).
 */

import type { KobeBinding } from "./keybindings.ts"

export const CHAT_BINDINGS: readonly KobeBinding[] = [
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
  {
    id: "tmux.layout.workspaceSplit",
    scope: "global",
    keys: [],
    category: "Workspace (tmux)",
    description: "Add a temporary workspace split (tmux prefix, then s)",
    hint: { keys: "prefix s", label: "split", status: false },
  },
  {
    id: "tmux.layout.workspaceClose",
    scope: "global",
    keys: [],
    category: "Workspace (tmux)",
    description: "Close the focused temporary workspace split (tmux prefix, then x)",
    hint: { keys: "prefix x", label: "close split", status: false },
  },
  {
    id: "tmux.layout.workspaceReset",
    scope: "global",
    keys: [],
    category: "Workspace (tmux)",
    description: "Close all temporary workspace splits (tmux prefix, then r)",
    hint: { keys: "prefix r", label: "reset splits", status: false },
  },
  {
    id: "tmux.layout.tasksToggle",
    scope: "global",
    keys: [],
    category: "Workspace (tmux)",
    description: "Hide / restore the Tasks pane (tmux prefix, then a)",
    hint: { keys: "prefix a", label: "tasks pane", status: false },
  },
  {
    id: "tmux.layout.opsToggle",
    scope: "global",
    keys: [],
    category: "Workspace (tmux)",
    description: "Toggle the file/Ops pane (tmux prefix, then o)",
    hint: { keys: "prefix o", label: "file pane", status: false },
  },
  {
    id: "tmux.layout.terminalToggle",
    scope: "global",
    keys: [],
    category: "Workspace (tmux)",
    description: "Hide / restore the terminal pane (tmux prefix, then z)",
    hint: { keys: "prefix z", label: "terminal", status: false },
  },
  {
    id: "tmux.layout.zenToggle",
    scope: "global",
    keys: [],
    category: "Workspace (tmux)",
    description: "Zen mode — collapse to the engine pane (tmux prefix, then space)",
    hint: { keys: "prefix space", label: "zen", status: false },
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
    keys: [],
    prefixKeys: ["t"],
    category: "Workspace",
    description: "New chat tab",
    hint: { keys: "ctrl+t", label: "new tab" },
  },
  {
    // tmux's chattab has a "prompt for engine, then open a tab" chord on
    // `ctrl+shift+t`. Can't reuse that chord here: same shift+letter collision
    // (the keymap layer drops shift+ on letter keys, so ctrl+shift+t and
    // ctrl+t are indistinguishable).
    // `ctrl+e` mirrors the "engine" mnemonic the new-task dialog already
    // uses for its own vendor cycle chord.
    id: "chat.tab.chooseEngine",
    scope: "workspace",
    keys: [],
    prefixKeys: ["e"],
    category: "Workspace",
    description: "New tab with a chosen engine or a plain shell",
    hint: { keys: "ctrl+e", label: "choose engine", status: false },
  },
  {
    // Quick-fork: from a focused chat tab, spin up a child
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
    // other panes.
    id: "chat.fork.new",
    scope: "workspace",
    keys: [],
    prefixKeys: ["f"],
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
    // history palette (claude-code parity) and `ctrl+h`
    // collides with terminals' backspace byte.
    id: "chat.session.resume",
    scope: "workspace",
    keys: [],
    prefixKeys: ["y"],
    category: "Workspace",
    description: "Resume a prior session in this task's worktree",
    hint: { keys: "ctrl+y", label: "resume", status: false },
  },
  {
    id: "chat.tab.close",
    scope: "workspace",
    keys: [],
    prefixKeys: ["w"],
    category: "Workspace",
    description: "Close chat tab",
    hint: { keys: "ctrl+w", label: "close tab", status: false },
  },
  {
    // Rename the active chat tab. F2 is the cross-OS / cross-IDE
    // rename convention (file managers on Windows + Linux, IntelliJ,
    // VS Code etc.) — chosen here because `ctrl+r` is owned by the
    // composer's prompt-history palette (claude-code parity). F2 has no other binding in kobe and doesn't
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
    keys: [],
    prefixKeys: ["]"],
    category: "Workspace",
    description: "Next chat tab",
    hint: { keys: "ctrl+]", label: "next tab", status: false },
  },
  {
    id: "chat.tab.cycle-prev",
    scope: "workspace",
    keys: [],
    prefixKeys: ["["],
    category: "Workspace",
    description: "Previous chat tab",
    hint: { keys: "ctrl+[", label: "prev tab", status: false },
  },
  {
    // tmux-style splits inside the active workspace tab (issue #16).
    // Deliberately CONTENT-NEUTRAL ids (`workspace.split.*`, not
    // chat/terminal): the split tree (`workspace/split-core.ts`) is
    // generic over leaf content — terminals today, other surfaces
    // later. `ctrl+\` reads as a vertical divider → new leaf to the
    // RIGHT; `ctrl+=` reads as horizontal strokes → new leaf BELOW.
    // Both need the kitty keyboard protocol (legacy terminals can't
    // encode ctrl+=; ctrl+\ would be SIGQUIT) — see docs/KEYBINDINGS.md.
    id: "workspace.split.right",
    scope: "workspace",
    keys: [],
    prefixKeys: ["\\"],
    category: "Workspace",
    description: "Split right",
    hint: { keys: "ctrl+\\", label: "split →", status: false },
  },
  {
    id: "workspace.split.down",
    scope: "workspace",
    keys: [],
    prefixKeys: ["="],
    category: "Workspace",
    description: "Split down",
    hint: { keys: "ctrl+=", label: "split ↓", status: false },
  },
  {
    // Split-focus cycle in reading order (tmux `prefix o`). F3 because
    // every useful ctrl+letter is either engine passthrough or
    // taken; F-keys already carry the tab
    // vocabulary here (F2 rename).
    id: "workspace.split.focus-next",
    scope: "workspace",
    keys: ["f3"],
    category: "Workspace",
    description: "Focus next split",
    hint: { keys: "f3", label: "next split", status: false },
  },
  {
    // Same chord as chat.tab.close, contextual scope: while the tab is
    // SPLIT, ctrl+w closes the active leaf (the innermost thing — VS
    // Code/iTerm/Warp convention, tmux `prefix x`). Resolution is mutual
    // gating (React stacks ancestors on top — see tui-react/lib/keymap.ts):
    // TerminalSplit enables this entry only when split, and TerminalTabs
    // disables its close-tab entry while split, so exactly one is live.
    id: "workspace.split.close",
    scope: "workspace",
    keys: [],
    prefixKeys: ["w"],
    category: "Workspace",
    description: "Close active split (tab when unsplit)",
    hint: { keys: "ctrl+w", label: "close split", status: false },
  },
  {
    // Same chord as chat.tab.rename, contextual like workspace.split.close:
    // while SPLIT, F2 renames the ACTIVE LEAF (owner semantics 2026-07-06 —
    // the tab is the "group", each leaf has its own name: rename wins over
    // the default basename of what it runs); unsplit tabs fall through the
    // LIFO stack to rename-tab.
    id: "workspace.split.rename",
    scope: "workspace",
    keys: ["f2"],
    category: "Workspace",
    description: "Rename active split (tab when unsplit)",
    hint: { keys: "f2", label: "rename split", status: false },
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
]
