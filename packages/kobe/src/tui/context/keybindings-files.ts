/**
 * `files.*` keybinding rows — split out of `keybindings.ts` (which was
 * over the repo's 500-line file-size cap) purely mechanically: same
 * entries, same order, moved verbatim. See `keybindings.ts`'s doc comment
 * for the full contract (id stability, scope semantics, hint display
 * rules).
 */

import type { KobeBinding } from "./keybindings-table.ts"

export const FILES_BINDINGS: readonly KobeBinding[] = [
  {
    // POSITIONAL: alternating [down, up] pairs (slot dispatch).
    id: "files.nav",
    scope: "files",
    keys: ["j", "k", "down", "up"],
    category: "Files",
    description: "Move cursor up/down",
    hint: { keys: "j/k" },
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
    hint: { keys: "h/l" },
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
    hint: { keys: "enter" },
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
    hint: { keys: "[/]" },
  },
  {
    id: "files.refresh",
    scope: "files",
    keys: ["r"],
    category: "Files",
    description: "Refresh",
    hint: { keys: "r" },
  },
  {
    // `b` → toggle the Changes tab between working-tree scope (uncommitted
    // work) and Branch scope (everything vs the base — the vs-base view).
    // Plain letter, files-scoped per the keybinding-boundaries rule.
    id: "files.scope",
    scope: "files",
    keys: ["b"],
    category: "Files",
    description: "Toggle Changes scope (working ↔ branch vs base)",
    hint: { keys: "b" },
  },
  {
    // `d` → open the current file's read-only diff in a workspace content
    // tab (a content swap, does not steal focus — KOB-25). Enter still opens
    // the editable editor tab; this is the non-focus-stealing diff view.
    id: "files.diff",
    scope: "files",
    keys: ["d"],
    category: "Files",
    description: "Open read-only diff in a workspace tab",
    hint: { keys: "d" },
  },
  {
    id: "files.openExternal",
    scope: "files",
    keys: ["o"],
    category: "Files",
    description: "Open file in system default app (audio / video / pdf preview)",
    hint: { keys: "o" },
  },
  {
    // `a` → inject `@<path>` into the engine (claude/codex) pane via
    // tmux send-keys. Enter stays the full-width preview; this
    // is the "add as a mention" action. Plain letter, files-scoped per
    // the keybinding-boundaries rule, so it can't collide elsewhere.
    id: "files.mention",
    scope: "files",
    keys: ["a"],
    category: "Files",
    description: "Inject @<path> mention into the engine pane",
    hint: { keys: "a" },
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
    hint: { keys: "p" },
  },
]
