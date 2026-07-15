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
| `ctrl+a`, `i` | Open the attention Inbox dialog (PROPOSED; awaiting owner confirmation) |
| `ctrl+a`, `y` | Resume a prior engine Session |
| `ctrl+a`, `j` | Cycle focus backward (Files → Workspace → Sidebar) |
| `ctrl+a`, `k` | Cycle focus forward (Sidebar → Workspace → Files) |
| `ctrl+a`, `\\` | Split right |
| `ctrl+a`, `=` | Split down |
| `ctrl+a`, `w` | Close active split |

High-frequency tab actions remain direct: `ctrl+t`, `ctrl+e`, `ctrl+w`,
`ctrl+[`, and `ctrl+]`. The escape hatch `ctrl+q` is also direct.

## Navigation and workspace defaults

| Key | Action |
|---|---|
| `ctrl+q` | Focus Sidebar; from Sidebar, quit |
| `F2` | Rename active tab or split |
| `F3` | Focus next split |
| `F4` | Cycle focus forward |
| `F5` | Confirm and reset the active terminal |
| `F6` | Toggle zen mode |
| `F7` | Open the next unread Inbox episode across every project and the current task's other tabs. Opening marks it read but does not remove it; read episodes remain available in the Inbox dialog. |
| `ctrl+t` | New engine tab |
| `ctrl+e` | New tab with engine/shell picker |
| `ctrl+w` | Close active split, otherwise close tab |
| `ctrl+[` / `ctrl+]` | Previous / next tab |

Context resolves intentional overlap. For example, `ctrl+w` closes the
innermost split when a tab is split; otherwise it closes the tab. `F2` renames
the active split when split, otherwise the tab.

Owner decision (2026-07-14): cross-pane navigation is relative and prefix-only.
`prefix+j` moves backward, `prefix+k` moves forward, and `F4` remains the
direct forward-cycle alias. The former absolute `focus.numeric` action and its
`ctrl+h/j/k/l` / `prefix+h/j/k/l` chords are removed so those Ctrl bytes reach
the embedded engine. Existing `focus.numeric` YAML entries are rejected as an
unknown binding instead of being silently migrated to different semantics.

## Sidebar and Files

Bare letters are owned only while their surface has focus and no text input or
dialog is active. The live F1 help lists every row and binding id.

Common Sidebar actions include `n` new task, `enter` open, `s` settings, `o`
open Worktree, `c` Kanban, `a` archive, `d` delete, `r` rename, `b` rename
branch, `v` change engine, `/` search, and `[`/`]` switch Working/Archives.

Common Files actions include `j/k` navigation, `h/l` collapse/expand, `enter`
preview, `e` open in the configured editor, and `[`/`]` switch file tabs.

The Inbox is a modal dialog opened with the proposed `prefix+i` sequence. Unread
episodes sort ahead of retained read episodes. Inside
the dialog, `j/k` selects, `enter` jumps to the task/chat tab, and `d` deletes
that attention episode. Opening marks its unread dot read; only a newer turn in
the same tab or `d` removes it. Owner decision (2026-07-15): `d` is direct and
dialog-scoped because deletion is a frequent, explicit cleanup action there;
it cannot shadow chat input or embedded-terminal shortcuts outside the dialog.

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
