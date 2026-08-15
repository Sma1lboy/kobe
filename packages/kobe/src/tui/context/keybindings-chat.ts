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
    presentation: "onePress",
  },
  {
    // Can't reuse `ctrl+shift+t`: it has the same shift+letter collision
    // (the keymap layer drops shift+ on letter keys, so ctrl+shift+t and
    // ctrl+t are indistinguishable).
    // `ctrl+e` mirrors the "engine" mnemonic the new-task dialog already
    // uses for its own vendor cycle chord. Direct-only (owner call
    // 2026-07-12): same reasoning as the tab-management rows above.
    // Since issue #7 this opens the UNIFIED new-conversation dialog:
    // default enter = the old "new tab with this engine", while in-dialog
    // `tab` flips the destination (tab ⇄ fork a child task) and `ctrl+f`
    // the context (fresh ⇄ continue) — owner sign-off 2026-08-10, see
    // docs/design/keybinding-decisions.md.
    id: "chat.tab.chooseEngine",
    scope: "workspace",
    keys: ["ctrl+e"],
    category: "Workspace",
    description: "New conversation — engine/shell picker with destination + context toggles",
    hint: { keys: "ctrl+e" },
    presentation: "onePress",
  },
  {
    // Fork the CONVERSATION, not the worktree: a new tab in the SAME
    // worktree that opens on this tab's history and then diverges
    // (claude `--resume … --fork-session`, `codex fork`). Sibling of
    // `chat.fork.new`, which forks the WORKTREE into a child task.
    // Chord signed off 2026-08-10 (issue #7): prefix + `c` ("continue")
    // is a PRESET entry into the unified `chat.tab.chooseEngine` dialog
    // with the context toggle pre-flipped to "continue".
    id: "chat.tab.fork",
    scope: "workspace",
    keys: [],
    prefixKeys: ["c"],
    category: "Workspace",
    description: "Fork this chat into a new tab (same Task directory, keeps the conversation)",
    hint: { keys: "ctrl+a c" },
  },
  {
    // Quick-fork: from a focused chat tab, spin up a child
    // task that inherits repo + branch + model from the source. The
    // dialog asks only for a prompt; the fork's first turn fires
    // immediately. Since issue #7 a PRESET entry into the unified
    // `chat.tab.chooseEngine` dialog with the destination toggle
    // pre-flipped to "fork a child task"; enter continues into the
    // same QuickTaskComposer as before.
    id: "chat.fork.new",
    scope: "workspace",
    keys: [],
    prefixKeys: ["f"],
    category: "Workspace",
    description: "Quick-fork: create child task seeded with current repo/branch/model",
    hint: { keys: "ctrl+a f" },
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
    description: "Resume a prior session in this Task directory",
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
    presentation: "onePress",
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
    presentation: "onePress",
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
    presentation: "onePress",
  },
  {
    id: "chat.tab.cycle-prev",
    scope: "workspace",
    // Direct-only (owner call 2026-07-11), same as cycle-next.
    keys: ["ctrl+["],
    category: "Workspace",
    description: "Previous chat tab",
    hint: { keys: "ctrl+[" },
    presentation: "onePress",
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
    // Direct-only (owner call 2026-07-22): back off the prefix, same
    // reasoning as the tab-management rows and ctrl+e.
    id: "workspace.split.right",
    scope: "workspace",
    keys: ["ctrl+\\"],
    category: "Workspace",
    description: "Split right",
    hint: { keys: "ctrl+\\" },
    presentation: "onePress",
  },
  {
    id: "workspace.split.down",
    scope: "workspace",
    keys: ["ctrl+="],
    category: "Workspace",
    description: "Split down",
    hint: { keys: "ctrl+=" },
    presentation: "onePress",
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
    presentation: "onePress",
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
    keys: ["ctrl+w"],
    prefixKeys: ["w"],
    category: "Workspace",
    description: "Close active split (tab when unsplit)",
    hint: { keys: "ctrl+w" },
    presentation: "onePress",
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
    presentation: "onePress",
  },
  // The Solid-era AskUserQuestion picker rows (`chat.question.*`) are gone:
  // the React TUI never registered them, so they were F1 noise advertising
  // keys that did nothing. The engine CLI owns its own question UI.
]
