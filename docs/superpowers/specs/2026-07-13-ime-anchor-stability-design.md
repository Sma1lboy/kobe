# Stable macOS IME anchor design

## Problem

The embedded Claude/Codex terminal draws its visible cursor as an inverse
cell, while the outer terminal's hardware cursor stays hidden and supplies the
anchor used by macOS input methods. KOBE already calls
`renderer.setCursorPosition(x, y, false)`, but OpenTUI 0.4.3 restores cursor
position at the end of a rendered frame only when the cursor is visible.

During an engine animation, OpenTUI's row-major diff leaves the hidden
hardware cursor at the last changed cell. macOS then moves the uncommitted
pinyin preedit and candidate popup to that cell even though the embedded PTY
cursor has not moved.

## Constraints

- Keep KOBE's inverse-cell visual cursor; the visible native-cursor experiment
  was previously reverted.
- Do not pause PTY output or disable engine animation. Both only mask the
  renderer defect.
- Do not write ANSI directly from `Terminal.tsx`; the renderer owns terminal
  output ordering.
- Preserve the OpenTUI 0.4.3 dependency and do not patch generated
  `node_modules` or ship a platform-specific native binary.
- Limit the output interposition to macOS fullscreen hosts, where the reported
  system IME behavior exists. Other platforms and inline command pages retain
  the direct `process.stdout` path.

## Design

### 1. Frame-final cursor anchoring

Create a framework-free macOS renderer-output adapter. OpenTUI supports a
custom stdout stream through its native span feed; KOBE supplies a proxy stream
that delegates to `process.stdout` after applying one streaming transform.

For every synchronized frame terminator (`CSI ? 2026 l`) while a terminal IME
anchor is active, the transform inserts the following bytes immediately before
the terminator:

```text
CUP(screenY + 1, screenX + 1) + DECTCEM hide
```

The cursor move is therefore committed in the same synchronized frame as the
screen diff. The hardware cursor remains invisible, but the outer terminal's
real cursor position ends every frame at the embedded PTY cursor.

The transformer carries a partial terminator prefix across output chunks, so
the invariant holds when OpenTUI's native feed splits an ANSI sequence.

Using a custom stream makes OpenTUI stop installing its own `SIGWINCH` handler.
The adapter therefore installs an equivalent resize forwarder and removes it
when the renderer is destroyed. The host passes `remote: false` so terminal
capability detection continues to describe the local terminal.

### 2. Separate visual cursor from IME anchor

`Terminal.tsx` continues to derive `visibleCursor` directly from the current
PTY cursor. A hidden PTY cursor therefore still hides the inverse-cell visual
cursor.

Separately, the terminal retains the last non-null PTY cursor for IME anchoring.
Transient `CSI ? 25 l` / `CSI ? 25 h` redraw intervals no longer send the
anchor to `(0, 0)`. The retained cursor is cleared when the PTY identity
changes, focus leaves the pane, or the pane unmounts.

Each mounted terminal owns a unique token. Anchor updates claim ownership;
release clears the global anchor only when the releasing token is still the
owner. This prevents an old split leaf's cleanup from clearing the anchor just
claimed by the newly focused leaf.

### 3. Failure and fallback behavior

When no terminal owns the anchor, the output adapter passes bytes through
unchanged. If the cursor has never been observed or is outside a historical
scrollback viewport, a focused pane keeps the prior valid screen anchor rather
than inventing an origin coordinate. On focus loss, KOBE parks the native
cursor at the origin as before; no IME composition belongs to that pane then.

## Verification

- Streaming-unit test: alternating left/right diff frames both end with the
  same hidden `CUP` before synchronized-update reset.
- Chunk-boundary test: every split point inside `CSI ? 2026 l` produces the
  same output as an unsplit frame.
- Ownership test: a stale terminal release cannot clear a newer terminal's
  anchor.
- Cursor-retention test: a transient null PTY cursor preserves the IME anchor
  while the visual cursor remains null; a PTY identity change clears it.
- Existing terminal IME key-forwarding render tests remain green.
- Pre-PR gates: lint, typecheck, fast + socket tests, render tests, build, and
  behavior tests.
- Manual acceptance: in iTerm with macOS pinyin, type while Claude animates;
  preedit and candidate popup stay at the prompt, with no visible second
  cursor and no CJK width drift.
