# Prefix pane cycle design

## Goal

Replace the four absolute global pane-navigation aliases with two relative
prefix actions. The default vocabulary becomes `prefix+j` for the pane to the
left and `prefix+k` for the pane to the right.

## Behavior

- `prefix+j` cycles left through Files -> Workspace -> Sidebar -> Files.
- `prefix+k` cycles right through Sidebar -> Workspace -> Files -> Sidebar.
- `F4` remains a direct alias for cycling right.
- `ctrl+h`, `ctrl+j`, `ctrl+k`, `ctrl+l`, `prefix+h`, and `prefix+l` are no
  longer Kobe defaults. When the embedded terminal has focus, the unclaimed
  direct control chords pass through to the child process.
- Dialog and page gates remain unchanged: pane navigation is disabled while a
  modal or full-page surface owns input.

## Keymap structure

Remove the absolute, four-slot `focus.numeric` binding and its positional
override contract. Add a global, prefix-only `focus.prev` binding for `j`.
Reuse the existing global `focus.next` binding for `prefix+k` while preserving
its direct `F4` chord.

The workspace host maps `focus.prev` to the existing pane-cycle helper with a
delta of `-1`, and `focus.next` to a delta of `1`. This keeps relative
navigation independent of the number of mounted panes and avoids retaining an
absolute four-pane model in the current three-pane host.

User keybinding files can override `focus.prev` and `focus.next` through the
existing direct/prefix alias mechanism. A legacy `focus.numeric` override is
reported as an unknown binding instead of silently retaining the removed
absolute-navigation behavior.

## User-facing surfaces

Update F1's English and Chinese descriptions, the stable defaults in
`docs/KEYBINDINGS.md`, and the changelog through one patch changeset. Record
the owner decision: relative `j`/`k` prefix navigation replaces both the old
prefix `h/j/k/l` aliases and the direct `ctrl+h/j/k/l` defaults.

## Verification

Fast deterministic tests will pin:

- the new default chords and the absence of `focus.numeric`;
- left/right wraparound through the real key-dispatch registration;
- user overrides for `focus.prev` and `focus.next`;
- terminal passthrough for the released direct control chords;
- F1/help text and keymap reset behavior.

The final gate is the repository-required lint, typecheck, test, build, and
behavior-test chain.

## Out of scope

The prefix first stroke, timeout, pane order, `F4`, `ctrl+q`, and all other
workspace or terminal bindings remain unchanged.
