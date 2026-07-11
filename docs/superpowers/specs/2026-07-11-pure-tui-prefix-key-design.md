# PureTUI prefix key design

## Goal

Give the Workspace Host Binding Stack a configurable, tmux-like two-stroke
prefix key without changing tmux Handover bindings or pane ownership.

## Contract

- The default prefix is `ctrl+a`; the second key must arrive within 1000 ms.
- Existing PureTUI `ctrl+…` rows in `KobeKeymap` become prefix rows. Their
  unmodified key becomes the second stroke (for example, `ctrl+t` becomes
  `ctrl+a t`). Non-control rows, function keys, and dialog-local controls stay
  direct.
- A prefix row is still registered at its existing Binding Stack site. The
  second stroke is matched only against enabled registrations above the modal
  barrier, so a Terminal Tab cannot run a Tasks pane action.
- Prefix configuration lives in `~/.kobe/settings/keybindings.yaml`:

  ```yaml
  prefix:
    key: ctrl+a
    timeoutMs: 1000
    bindings:
      chat.tab.new: t
  ```

  `prefix.key` changes every prefix row at once. `prefix.bindings` changes
  only a row's second stroke. A platform section may provide the same `prefix`
  object and replaces the corresponding scalar or binding id.
- The first stroke, a timed-out second stroke, `escape`, and an unknown second
  stroke are consumed. This prevents accidental text or bytes reaching a
  focused input or Terminal pane.
- Reloading user keybindings restores defaults, applies the current prefix
  configuration, and clears an armed prefix.

## Boundaries

The dispatcher remains framework-free in `src/tui/lib`; React's `useBindings`
continues to own Binding Stack registration. `KobeKeymap` stays the canonical
catalogue for help and hints. The tmux resolver continues to read only
`tmux.*` entries and is not changed.

## Verification

Pure tests cover successful scoped dispatch, timeout, cancellation, unknown
second strokes, modal cut-off, config parsing/overlay, and reset on reload.
Existing direct chord and slot tests remain regression coverage.
