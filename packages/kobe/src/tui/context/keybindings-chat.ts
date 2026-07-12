/** Workspace keybinding rows, split out to keep the keymap table small. */

import type { KobeBinding } from "./keybindings-table.ts"

export const CHAT_BINDINGS: readonly KobeBinding[] = [
  // ─── Workspace ────────────────────────────────────────────────────────
  {
    // Composer textarea handles enter via its own onKeyDown. This row
    // exists only for help-dialog visibility; no chord is registered
    // here.
    id: "chat.send",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Send message (composer)",
    hint: { keys: "enter" },
  },
  {
    // Composer textarea inserts a literal newline on shift+enter (kitty/
    // CSI-u terminals) and ctrl+J everywhere else; no chord is registered
    // here. Surfaced in Help (F1) so the user doesn't have to memorize
    // it after we stripped the inline footer hint from the composer.
    id: "chat.newline",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Newline in composer",
    hint: { keys: "shift+enter" },
  },
  {
    // Shift+tab inside the composer cycles the per-task permission mode
    // (default ↔ plan); the chord is registered in
    // Composer's onKeyDown, not here. Doc-only entry so Help (F1)
    // advertises the binding to a focused user.
    id: "chat.cycle-mode",
    scope: "workspace",
    keys: [],
    category: "Workspace",
    description: "Cycle permission mode (composer)",
    hint: { keys: "shift+tab" },
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
    hint: { keys: "ctrl+enter" },
  },
  {
    id: "chat.tab.new",
    scope: "workspace",
    // Direct-only (owner call 2026-07-11): tab management is
    // high-frequency, so the single-press chord returned and the prefix
    // stroke was dropped.
    keys: ["ctrl+t"],
    category: "Workspace",
    description: "New chat tab",
    hint: { keys: "ctrl+t" },
  },
  {
    // Can't reuse `ctrl+shift+t`: it has the same shift+letter collision
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
    hint: { keys: "ctrl+e" },
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
    hint: { keys: "ctrl+f" },
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
    hint: { keys: "ctrl+y" },
  },
  {
    id: "chat.tab.close",
    scope: "workspace",
    // Direct-only (owner call 2026-07-11), same as chat.tab.new.
    keys: ["ctrl+w"],
    category: "Workspace",
    description: "Close chat tab",
    hint: { keys: "ctrl+w" },
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
    hint: { keys: "f2" },
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
    // Direct-only (owner call 2026-07-11): cycling is a repeated action —
    // a two-stroke prefix per hop is unusable.
    keys: ["ctrl+]"],
    category: "Workspace",
    description: "Next chat tab",
    hint: { keys: "ctrl+]" },
  },
  {
    id: "chat.tab.cycle-prev",
    scope: "workspace",
    // Direct-only (owner call 2026-07-11), same as cycle-next.
    keys: ["ctrl+["],
    category: "Workspace",
    description: "Previous chat tab",
    hint: { keys: "ctrl+[" },
  },
  {
    // Splits inside the active workspace tab (issue #16).
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
    hint: { keys: "ctrl+\\" },
  },
  {
    id: "workspace.split.down",
    scope: "workspace",
    keys: [],
    prefixKeys: ["="],
    category: "Workspace",
    description: "Split down",
    hint: { keys: "ctrl+=" },
  },
  {
    // Split-focus cycle in reading order. F3 because
    // every useful ctrl+letter is either engine passthrough or
    // taken; F-keys already carry the tab
    // vocabulary here (F2 rename).
    id: "workspace.split.focus-next",
    scope: "workspace",
    keys: ["f3"],
    category: "Workspace",
    description: "Focus next split",
    hint: { keys: "f3" },
  },
  {
    // Same chord as chat.tab.close, contextual scope: while the tab is
    // SPLIT, ctrl+w closes the active leaf (the innermost thing — VS
    // Code/iTerm/Warp convention). Resolution is mutual
    // gating (React stacks ancestors on top — see tui-react/lib/keymap.ts):
    // TerminalSplit enables this entry only when split, and TerminalTabs
    // disables its close-tab entry while split, so exactly one is live.
    id: "workspace.split.close",
    scope: "workspace",
    keys: [],
    prefixKeys: ["w"],
    category: "Workspace",
    description: "Close active split (tab when unsplit)",
    hint: { keys: "ctrl+w" },
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
    hint: { keys: "f2" },
  },
  // AskUserQuestion picker bindings — only fire when a question card is
  // up (QuestionRow gates `enabled` on its own state). j/k/space/enter/
  // 1-9 are bare-letter chords by intent: while a picker is showing, the
  // composer is hidden (Chat.tsx `<Show when={!pendingQuestion()}>`) so
  // these never compete with composer typing. Workspace scope means the
  // chat pane must own focus — the user can still navigate the file tree
  // with j/k while a question is queued.
  //
  {
    id: "chat.question.nav",
    scope: "workspace",
    keys: ["j", "k", "down", "up"],
    category: "Workspace",
    description: "Move highlight in question picker",
    hint: { keys: "j/k" },
  },
  {
    id: "chat.question.toggle",
    scope: "workspace",
    keys: ["space"],
    category: "Workspace",
    description: "Toggle highlighted option in question picker",
    hint: { keys: "space" },
  },
  {
    id: "chat.question.submit",
    scope: "workspace",
    keys: ["return"],
    category: "Workspace",
    description: "Advance / submit question picker",
    hint: { keys: "enter" },
  },
  {
    id: "chat.question.pick-number",
    scope: "workspace",
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    category: "Workspace",
    description: "Pick option by number in question picker",
    hint: { keys: "1-9" },
  },
]
