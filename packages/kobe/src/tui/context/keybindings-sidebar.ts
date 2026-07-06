/**
 * `sidebar.*` / `tasks.*` keybinding rows — split out of `keybindings.ts`
 * (which was over the repo's 500-line file-size cap) purely mechanically:
 * same entries, same order, moved verbatim. See `keybindings.ts`'s doc
 * comment for the full contract (id stability, scope semantics, hint
 * display rules).
 */

import type { KobeBinding } from "./keybindings.ts"

export const SIDEBAR_BINDINGS: readonly KobeBinding[] = [
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
    description: "Reorder task (Shift+M, then j/k)",
    hint: { keys: "M", label: "reorder", status: false },
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
    // `i` opens the cursor task in a live read-only preview (the `kobe history`
    // renderer tailing the transcript) in the engine pane slot instead of the
    // engine, and toggles back on a second press. For inspecting a task an agent
    // is working in without driving it. Same beta gate as the archived preview.
    id: "sidebar.previewToggle",
    scope: "sidebar",
    keys: ["i"],
    category: "Sidebar",
    description: "Toggle live preview for task (i)",
    hint: { keys: "i", label: "preview", status: false },
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
    id: "sidebar.projectFilter",
    scope: "sidebar",
    keys: ["ctrl+p"],
    category: "Sidebar",
    description: "Cycle task project filter",
    hint: { keys: "ctrl+p", label: "project", status: false },
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
    // Right arrow jumps from the Tasks pane back into the current
    // window's engine (claude/codex) pane — the spatial "go right into
    // the conversation" gesture, the inverse of ctrl+h. Named key, not a
    // bare letter, but still sidebar-scoped per the boundary rule; the
    // Tasks-pane host gates it on no dialog + `/`-search inactive, so
    // Right typed while searching keeps moving the input cursor.
    id: "tasks.focusEngine",
    scope: "sidebar",
    keys: ["right"],
    category: "Tasks pane",
    description: "Focus the engine pane of the current window",
    hint: { keys: "→", label: "engine", status: false },
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
]
