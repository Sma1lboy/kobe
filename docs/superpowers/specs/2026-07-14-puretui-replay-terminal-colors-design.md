# PureTUI replay terminal-color fidelity design

## Goal

Make the native PureTUI replay capture behave like a real bidirectional
terminal for default-color queries, then prove the resulting Brand Studio
render against the fixed-viewport `/harness` ground truth.

## Root cause

The retired tmux capture used `capture-pane -ep` to materialize a complete
screen with ANSI attributes. The replacement correctly materializes the
screen through `@xterm/headless`, but its outer sidecar only forwards child
output into xterm. It does not forward xterm replies to the child. In
addition, headless xterm raises OSC 10/11 color-report events without a
browser color manager, so default foreground/background queries receive no
reply.

The result is a complete text grid with incomplete terminal negotiation.
OpenTUI or a native engine can choose fallback colors before the grid is
serialized, so the renderer cannot recover the intended palette afterward.

## Design

- Register explicit OSC 10 and OSC 11 query handlers on each capture xterm.
  Reply only to the `?` query form; allow non-query OSC color operations to
  fall through to xterm.
- Encode replies as `OSC <slot>;rgb:rrrr/gggg/bbbb ST`, matching the format
  consumed by Codex and emitted by real terminals.
- Forward all xterm `onData` replies to the live PTY child. Existing CSI/DA
  replies and the new color replies therefore share one ordered channel.
- Source the capture foreground/background from the validated replay theme,
  not hard-coded renderer colors.
- Keep replay parsing one-way: historical bytes must never generate fresh
  replies to a live child.
- Do not change the Brand Studio palette to hide protocol errors.

## Verification

- Unit tests prove that OSC 10/11 queries produce the declared theme colors,
  non-query OSC operations fall through, and emulator replies reach the PTY.
- The existing replay unit suite, typecheck, lint, build, and behavior suite
  remain green.
- A fresh native capture and Remotion render must identify current Kobe and
  current native engine content rather than the historical tmux recording.
- Compare a fixed-viewport `/harness` screenshot with an extracted replay
  frame. Text, default background, accent colors, engine colors, and contrast
  must be visibly consistent, with no blank, black, white-on-white, or stale
  tmux artifacts.
