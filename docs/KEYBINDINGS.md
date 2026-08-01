# Keybindings

`F1` renders the live, localized keymap and is authoritative. This document
defines ownership rules and the stable default vocabulary.

## Dispatch model

Kobe has one PureTUI Binding Stack. Bindings are resolved from the innermost
active modal/focused surface outward. A modal barrier prevents background
surfaces from consuming keys while a dialog owns input.

The embedded engine terminal receives unclaimed terminal input. Kobe reserves
only its explicit global/workspace chords; do not add broad interceptors that
break engine-native shortcuts.

## PureTUI prefix

The default first stroke is `ctrl+a`. Prefix-only actions then consume one
second key within 1000 ms. The HUD shows the pending prefix and cancels on
timeout, modal changes, reload, or an invalid second stroke.

Default prefix actions:

| Sequence | Action |
|---|---|
| `ctrl+a`, `f` | Quick-fork a child task |
| `ctrl+a`, `i` | Open the Inbox dialog |
| `ctrl+a`, `y` | Resume a prior engine Session |
| `ctrl+a`, `h` | Cycle focus backward (Files → Workspace → Sidebar) |
| `ctrl+a`, `l` | Cycle focus forward (Sidebar → Workspace → Files) |
| `ctrl+a`, `o` | Open the active task Worktree in the configured editor |
| `ctrl+a`, `m` | Enter sidebar Move mode on the current selection (j/k reorders projects/tasks, enter/esc exits; owner picked prefix+m 2026-07-16) |
| `ctrl+a`, `w` | Close active split |
| `ctrl+a`, `1` | Point the content pane at the Kanban (kobe's own issue board) |
| `ctrl+a`, `2` | Point the content pane at Automations (scheduled tasks) |
| `ctrl+a`, `z` | Toggle zen mode (prefix-only, owner call 2026-07-17; the old F6 direct chord is released to the shell; not reachable from inside the terminal pane, use the sidebar ☯ ZEN chip there) |

The rail pages take digits, not letters (owner call 2026-08-01): they are one
kind of thing — "point the content pane at X" — and their order on the rail is
the mnemonic. Kanban moved off the `c` it shipped with for that reason. Clicking
a rail row does the same thing.

Rail pages (Kanban / Automations / Issues) do NOT disable the prefix: they
replace only the content pane, so `ctrl+a` `u` switches from one to another
and `ctrl+a` `c` goes back without an `esc` first. Their own bare keys
(`j`/`k`/`d`/`enter`) are gated on the content pane holding focus, so they
never collide with the sidebar's identically-named chords.

High-frequency tab actions remain direct: `ctrl+t`, `ctrl+e`, `ctrl+w`,
`ctrl+[`, and `ctrl+]`. The escape hatch `ctrl+q` is also direct. Splits are
direct again: `ctrl+\` (right) and `ctrl+=` (down), owner call 2026-07-22;
their prefix strokes are dropped, same reasoning as the tab rows.

## Navigation and workspace defaults

| Key | Action |
|---|---|
| `ctrl+q` | Focus Sidebar; from Sidebar, quit |
| `F2` | Rename active tab or split |
| `F3` | Focus next split |
| `F4` | Cycle focus forward |
| `F5` | Confirm and reset the active terminal |
| `F7` | Jump to the next available Inbox item across all projects, Tasks, and Terminal Tabs. Visiting its target removes the item from the queue. |
| `ctrl+t` | New engine tab |
| `ctrl+e` | New tab with engine/shell picker |
| `ctrl+w` | Close active split, otherwise close tab |
| `ctrl+[` / `ctrl+]` | Previous / next tab |
| `ctrl+\` | Split right |
| `ctrl+=` | Split down |
| `ctrl+2` … `ctrl+9`, `ctrl+0` | Jump to the row printing that digit in the sidebar |

Context resolves intentional overlap. For example, `ctrl+w` closes the
innermost split when a tab is split; otherwise it closes the tab. `F2` renames
the active split when split, otherwise the tab.

Owner decision (2026-07-14): cross-pane navigation is relative and prefix-only.
`F4` remains the direct forward-cycle alias. The former absolute
`focus.numeric` action and its `ctrl+h/j/k/l` / `prefix+h/j/k/l` chords are
removed so those Ctrl bytes reach the embedded engine. Existing
`focus.numeric` YAML entries are rejected as an unknown binding instead of
being silently migrated to different semantics.

Owner decision (2026-07-17): the relative chords are `prefix+h` (backward) and
`prefix+l` (forward), not j/k. The three panes are laid out horizontally, so
left/right vim keys match the spatial direction.

Owner decision (2026-07-29): `ctrl+<digit>` jumps straight to a task, and is
GLOBAL rather than sidebar-scoped: the whole value is switching tasks without
leaving the engine pane, so the digits are reserved out of the terminal
passthrough (`RESERVED_GLOBAL_CHORDS`). The cost is the embedded shell's
ctrl+digit control bytes; the real escape and backspace keys are untouched.

**Each row prints the digit that jumps to it** (`panes/sidebar/jump-digits.ts`;
one list feeds the chord table, the handler, and the renderer). That is what
makes the feature usable rather than clever:

- `ctrl+1` does not exist. The legacy terminal protocol has no encoding for it
  (only ctrl+2…ctrl+8 map to C0 bytes; 1, 9 and 0 send nothing), verified on
  the owner's terminal. The first row prints, and answers to, `2`. Nobody
  computes an offset because the number is right there.
- Under the **`recent`** sort the list reorders as you switch, so the digits
  reorder with it. Reading them off the screen is the intended interaction:
  the digit is "where this task sits right now", not a permanent address. The
  task you are in sits at the top, so the digits read as distance from where
  you are. Want fixed addresses instead? `t` switches the sidebar to the
  **`default`** sort, whose order is stored and never reshuffles on its own.
- A row past the ninth prints no digit, and a chord with no row does nothing.
  A jump that silently lands somewhere else is worse than one that does
  nothing.

Owner decision (2026-07-25): focus movement is a cursor, not a ring. It clamps
at both ends (sidebar on the left, files on the right) instead of wrapping.
`prefix+h` from the sidebar and `prefix+l`/`F4` from files are no-ops.

## Sidebar and Files

Bare letters are owned only while their surface has focus and no text input or
dialog is active. The live F1 help lists every row and binding id.

Common Sidebar actions include `n` new task, `enter` open, `s` settings, `o`
open Worktree, `a` archive, `d` delete, `r` rename, `b` rename branch, `v`
change engine, `/` search, `u` open the Update page (version check +
one-key updater), and `[`/`]` switch Working/Archives.

Owner decision (2026-07-29): the Kanban is `prefix+c`, global scope, no direct
chord, demoted from the bare sidebar `c` it originally shipped with. The
sidebar's bare letters are per-task verbs (new, archive, delete, rename); the
Kanban is a step-back-and-look surface, so it belongs with the other whole-page
views reached through the prefix (`prefix+i` Inbox). Going global also means it
opens from any pane instead of only under sidebar focus. `c` (cards) survives as
the second stroke; the mnemonic letters k/b/i were already taken.

Common Files actions include `j/k` navigation, `h/l` collapse/expand, `enter`
preview, `e` open in the configured editor, and `[`/`]` switch file tabs.

Create PR is `prefix+p` / `prefix+P`, global scope, no direct chord (owner
call 2026-07-18, superseding the 2026-07-17 files-scoped `ctrl+p`): the direct
chord was unreachable from where the owner actually sits (on the sidebar
`ctrl+p` is the project filter, and inside the terminal it passes through to
the engine), so his muscle memory went to the prefix route, which was unbound
(HUD showed `ctrl+a + shift+p ∅`). Both `p` and `shift+p` are bound because
"PR" reads uppercase and the capital press must land. The handler also guards
the target branch: firing it on a session sitting on the PR base (a project
main session) surfaces a toast instead of sending the engine a doomed
`gh pr create`.

Uppercase letters are distinct chords: a keypress with shift is matched as
`shift+<letter>` first, falling back to the bare letter, so `P` (written
`shift+p` or just `P` in YAML) can be bound apart from `p`. Shift combined
with other modifiers on a letter (`ctrl+shift+p`) stays invalid: legacy
terminals send the same byte with and without shift there.

The Inbox is a modal dialog opened with `prefix+i`. Every row is a pending
item, ordered oldest first. Inside the dialog, `j/k` selects. `enter` opens the
target Task and Terminal Tab when available; either way, it removes the item
from the queue. `d` removes it without navigating. Landing on a target also
removes matching items because visiting means handled. A newer item for the
same Task and Terminal Tab replaces the older one and moves to the end of the
queue. Owner decision (2026-07-15): `d` is direct and dialog-scoped because
removal is a frequent, explicit cleanup action there; it cannot shadow input
or embedded-terminal shortcuts outside the dialog.

Diff review notes live in the read-only diff content tab (workspace focus,
diff kind only, inert elsewhere): `j/k` (and arrows) line cursor, `v` range
anchor, `c` note dialog, `s` send all unsent notes to the engine session.
Owner decision (2026-07-27): plain direct letters, diff-tab-scoped. They
follow the same raw-binding precedent as the preview's `o` (system open), so
they cannot shadow the composer, embedded terminals, or any other pane. The
central table carries documentation-only rows (`diff.review.*`) so F1 and
the legend list them.

## User customization

Edit `~/.kobe/settings/keybindings.yaml`. Changes reload live through the
daemon watcher.

```yaml
prefix:
  key: ctrl+a          # null disables prefix bindings
  timeoutMs: 1000
  bindings:
    chat.fork.new: f

bindings:
  chat.tab.new: ctrl+t
  chat.tab.chooseEngine: ctrl+e
  sidebar.select: [enter]
  files.createPR: null
darwin:
  bindings:
    files.openExternal: cmd+o
```

A direct override replaces the binding's complete direct-chord list. `null`
or `[]` unbinds it. Prefix overrides contain second-stroke keys and retain the
binding's original pane scope and modal rules.

Positional groups must preserve their documented slot count/order. Invalid or
unknown entries are ignored with warnings shown in Settings → Keybindings.

### Plugin chords (`plugins:` section)

Bind a chord to an installed plugin's pane or action (docs/design/plugins.md):

```yaml
plugins:
  ctrl+g: pane:examples.lazygit.git
  f6: action:examples.notify.test
darwin:
  plugins:
    cmd+g: pane:examples.lazygit.git   # platform overlay wins per chord
```

Resolution (owner sign-off 2026-07-28): kobe ships **no default plugin
chords**. Every plugin chord is the user's own placement call, so the
catalogue/help surfaces don't list them. They register at the workspace-host
level with the same open-page gating as global rows; a chord that shadows a
catalogue binding applies with a warning. Fire path is a detached
`kobe plugin pane open|action invoke`: chord-fired actions have no
terminal, so interactive pickers belong in panes.

## Adding or moving a chord

Chord placement is an owner decision. Before treating a new or moved binding
as settled, get owner sign-off on direct versus prefix placement, the selected
key, and any engine/terminal shortcut it may shadow. Record that decision and
its reasoning here.

1. Add or change the stable binding row in `tui/context/keybindings-*.ts`.
2. Register its handler at the narrowest correct focused surface.
3. Check conflicts across direct and prefix forms.
4. Update F1 localization, focused tests, and this document when the default
   vocabulary changes.
5. Verify terminal passthrough for unclaimed keys.
