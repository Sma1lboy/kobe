# Keybinding decisions

The reasoning behind kobe's chord placements, newest first within each topic.
Chord placement is an **owner decision** (see the rule in `CLAUDE.md`); this
file is where each resolution and its reasoning is recorded so the next agent
has the context.

The user-facing vocabulary lives in [`../KEYBINDINGS.md`](../KEYBINDINGS.md).
`F1` renders the live keymap and is authoritative over both.

## Open calls

- **`ctrl+a` `c` (continue chat in a new tab)** — PROPOSED, awaiting owner
  sign-off. `c` was freed when the Kanban moved to a digit; mnemonic
  "continue".
- **Inert table rows.** `sidebar.sort` (`t`), `sidebar.projectFilter`
  (`ctrl+p`), `sidebar.previewToggle` (`i`), and `tasks.toggleKeys` (`?`) are
  registered in the keymap table but have **no handler**, so pressing them
  does nothing today. F1 filters them out by reachability, so they aren't
  advertised either. Whether to wire them back or drop the rows is an open
  owner call.
  - For `sidebar.sort` specifically: a tree already carries an order (project
    → worktree → tab) and manual placement lives in move mode, so a second
    automatic ordering would only fight the structure. But the row was never
    removed and `activeSortMode` is still read at startup, so today the sort
    mode changes only by hand-editing `state.json`.
  - `sidebar.projectFilter`'s project filter was a fold, and the fold is gone.

## The prefix

**2026-08-10 — the configured prefix first stroke is Kobe-owned even inside
the embedded terminal.** This makes the command layer and content-scoped
prefix actions reachable without leaving the pane. The explicit cost of the
default is that the terminal no longer receives `ctrl+a` for shell
line-start; disabling the prefix or rebinding it releases the old key to the
PTY immediately. Unlike fixed global chords, this reservation follows live
user configuration. A sequence armed outside the terminal still cancels when
focus crosses the PTY boundary, so a pending pane command cannot leak into
the engine accidentally.

**2026-08-09 — `f1` is reserved out of terminal passthrough**
(`RESERVED_GLOBAL_CHORDS`), so F1 opens the help reference from inside the
embedded terminal too. It was the one F-row gap (f2–f5, f7 were already
reserved), the docs promise "F1 anywhere", and the status-bar hint advertises
F1 inside the terminal — all three lied while f1 passed through. No engine
CLI binds F1.

## Rail pages take digits, not letters

**2026-08-01.** Kanban, Automations, and GitHub Issues are one kind of thing
— "point the content pane at X" — and their order on the rail is the
mnemonic. Kanban moved off the `c` it shipped with for that reason.

Rail pages do NOT disable the prefix: they replace only the content pane, so
`ctrl+a` `2` switches from one to another and `ctrl+a` `1` goes back without
an `esc` first. Their own bare keys (`j`/`k`/`d`/`enter`) are gated on the
content pane holding focus, so they never collide with the sidebar's
identically-named chords.

**Superseded history.** 2026-07-29: the Kanban left the bare sidebar `c` it
originally shipped with — the sidebar's bare letters are per-task verbs (new,
archive, delete, rename), while the Kanban is a step-back-and-look surface,
so it belonged with the other whole-page views reached through the prefix
(`prefix+i` Inbox). Going global also meant it opened from any pane instead
of only under sidebar focus. It took `prefix+c` (cards) for two days, then
moved to `prefix+1` when the rail made it row 1 of a set.

## Focus navigation

**2026-07-25 — focus movement is a cursor, not a ring.** It clamps at both
ends (sidebar on the left, files on the right) instead of wrapping.
`prefix+h` from the sidebar and `prefix+l`/`F4` from files are no-ops.

**2026-07-17 — the relative chords are `prefix+h` (backward) and `prefix+l`
(forward), not j/k.** The three panes are laid out horizontally, so
left/right vim keys match the spatial direction.

**2026-07-14 — cross-pane navigation is relative and prefix-only.** `F4`
remains the direct forward-cycle alias. The former absolute `focus.numeric`
action and its `ctrl+h/j/k/l` / `prefix+h/j/k/l` chords were removed so those
Ctrl bytes reach the embedded engine. Existing `focus.numeric` YAML entries
are rejected as an unknown binding instead of being silently migrated to
different semantics.

## Task jump digits

**2026-07-29 — `ctrl+<digit>` jumps straight to a task, and is GLOBAL rather
than sidebar-scoped.** The whole value is switching tasks without leaving the
engine pane, so the digits are reserved out of terminal passthrough
(`RESERVED_GLOBAL_CHORDS`). The cost is the embedded shell's ctrl+digit
control bytes; the real escape and backspace keys are untouched.

**Each row prints the digit that jumps to it** (`panes/sidebar/jump-digits.ts`;
one list feeds the chord table, the handler, and the renderer). That is what
makes the feature usable rather than clever:

- `ctrl+1` does not exist. The legacy terminal protocol has no encoding for
  it (only ctrl+2…ctrl+8 map to C0 bytes; 1, 9 and 0 send nothing), verified
  on the owner's terminal. The first row prints, and answers to, `2`. Nobody
  computes an offset because the number is right there.
- Under the `recent` sort the list reorders as you switch, so the digits
  reorder with it. Reading them off the screen is the intended interaction:
  the digit is "where this task sits right now", not a permanent address. The
  task you are in sits at the top, so the digits read as distance from where
  you are.
- A row past the ninth prints no digit, and a chord with no row does nothing.
  A jump that silently lands somewhere else is worse than one that does
  nothing.

## The tree sidebar

**2026-08-01 — the tree never folds.** Every project and worktree always
shows everything under it — no twisties, no collapse state, no
Expand/Collapse menu entries. The tree is the map; hiding rows made it lie.

`sidebar.tree.open` (`l` / `space`) opens the row under the cursor, the same
thing `enter` does. On a tab row (the last level) that means entering the
tab's chat; the chord exists so the vim right-hand "go in" gesture works
without reaching for enter. `h` is unbound in the tree (there is no fold for
it to drive) and stays reserved. The chord replaced the withdrawn
`sidebar.tree.toggle` (`h`/`l`/`space`) proposal when the fold itself was
removed; the resolution is the owner's "no fold, `l` enters" directive, so no
further sign-off is pending.

The tree deliberately adds NO other chords. Two existing chords mean
something tree-shaped inside it:

- `/` (`sidebar.search.enter`) — the same search chord with a wider haystack:
  on top of a task's title + repo, a query also matches a worktree's branch
  and a tab's live title. Matches keep their ancestors so a hit is never
  orphaned from its project.
- `prefix+m` (`task.moveMode`) — the same global move mode retargeted at the
  level the tree actually shows: `j`/`k` drag the cursor row's **project**,
  not its task. It rides on the project's `main` checkout, which `moveTask`
  already reorders among mains, so project order needed no new persistence
  and no new daemon verb. A repo with no main checkout has no row to move,
  and the chord is a silent no-op there.

Right-click on any row opens that row's menu. The entries are exactly what
the row's own chords already do, so the menu never becomes a second place
where behavior is decided — the one exception is the project header, which
the cursor cannot reach at all.

## Create PR

**2026-07-18 — `prefix+p` / `prefix+P`, global scope, no direct chord**
(superseding the 2026-07-17 files-scoped `ctrl+p`). The direct chord was
unreachable from where the owner actually sits: on the sidebar `ctrl+p` was
the project filter, and inside the terminal it passed through to the engine.
His muscle memory went to the prefix route, which was unbound (the HUD showed
`ctrl+a + shift+p ∅`). Both `p` and `shift+p` are bound because "PR" reads
uppercase and the capital press must land.

The handler also guards the target branch: firing it on a session sitting on
the PR base (a project main session) surfaces a toast instead of sending the
engine a doomed `gh pr create`.

## Other placements

- **2026-07-27 — diff review letters** (`j/k`, `v`, `c`, `s`) are plain
  direct letters, diff-tab-scoped. They follow the same raw-binding precedent
  as the preview's `o` (system open), so they cannot shadow the composer,
  embedded terminals, or any other pane. The central table carries
  documentation-only rows (`diff.review.*`) so F1 and the legend list them.
- **2026-07-22 — splits are direct again**: `ctrl+\` (right) and `ctrl+=`
  (down). Their prefix strokes are dropped, same reasoning as the tab rows.
- **2026-07-17 — zen is prefix-only** (`prefix+z`); the old F6 direct chord
  is released to the shell.
- **2026-07-16 — move mode is `prefix+m`.**
- **2026-07-15 — the Inbox's `d`** (remove without navigating) is direct and
  dialog-scoped, because removal is a frequent, explicit cleanup action
  there; it cannot shadow input or embedded-terminal shortcuts outside the
  dialog.

## Plugin chords

**2026-07-28 — kobe ships no default plugin chords.** Every plugin chord is
the user's own placement call, so the catalogue/help surfaces don't list
them. They register at the workspace-host level with the same open-page
gating as global rows; a chord that shadows a catalogue binding applies with
a warning. Fire path is a detached `kobe plugin pane open|action invoke` —
chord-fired actions have no terminal, so interactive pickers belong in panes.

## Discoverability surfaces

**2026-08-09** (terminal prefix reachability corrected 2026-08-10). Four
restrained surfaces teach the grammar. None re-implements the which-key map,
and all captions resolve through the live keymap
(`src/tui/lib/keyboard-hints.ts`), so a rebound chord shows its new key and
an unbound/disabled one drops out:

- **Status-bar micro-hint** — a permanent `{prefix} commands · F1 help ·
  [settings]` row in the workspace footer's right corner, including inside
  the embedded terminal. When no prefix action is reachable there, it falls
  back to the `ctrl+q` escape hatch; with a modal open, or the prefix
  disabled and help unbound, tokens drop until nothing renders. Every segment
  is mouse-activatable — clicking `commands` arms the REAL prefix (the guide
  accepts a keyboard second stroke), clicking the help caption opens F1, and
  the `[settings]` button opens Settings even while the terminal owns
  keyboard input, since mouse clicks never pass through.
- **First-use pane hints** — one muted line per vim-style pane (sidebar:
  `j/k move · ⏎ open`; files: move/fold/open/diff). Using that pane's own
  nav/select keys extinguishes its line permanently; the files pane then
  falls back to its short permanent `⏎ open · d diff` footer.
- **Onboarding wizard "Keyboard basics" page** — one informational screen
  after the first-run questions (skippable with the wizard).
- **Settings** — General → "Keyboard hints" toggles all hint surfaces
  (re-enabling relights extinguished pane hints); Keybindings keeps a
  one-paragraph grammar summary with the live prefix/timeout values.

Hints are text-only on the ambient background (no opaque fill), so normal and
transparent themes both stay readable — pinned by
`test/tui-react/keyboard-overlay-theme.test.ts` and the `/harness` visual
journey `keyboard hints render and extinguish in the real OpenTUI`.

## Adding or moving a chord

Get owner sign-off on direct versus prefix placement, the selected key, and
any engine/terminal shortcut it may shadow. Then:

1. Add or change the stable binding row in `tui/context/keybindings-*.ts`.
2. Register its handler at the narrowest correct focused surface.
3. Check conflicts across direct and prefix forms.
4. Update F1 localization, focused tests, and
   [`../KEYBINDINGS.md`](../KEYBINDINGS.md) when the default vocabulary
   changes.
5. Verify terminal passthrough for unclaimed keys.
6. Record the resolution and its reasoning in this file.
