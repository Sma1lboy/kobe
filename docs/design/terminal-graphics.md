# Terminal graphics: why Rove renders images as cells

**Decision (2026-07-29): Rove keeps character-cell rendering. The kitty
graphics path is not being built.** This note records the evidence so the
question doesn't get re-opened from first principles.

## The question

Rove's image / video / browser plugins all paint half-block truecolor
cells instead of real images. herdr — the comparable product — renders
real images over the kitty graphics protocol. Should Rove switch?

## What the comparison actually shows

herdr's hosting model is **the same as Rove's**: child in a PTY → bytes
into its own embedded VT emulator → read back a cell grid → compose its
own frame. No full-screen takeover, no blind passthrough.

The difference is **which emulator**:

| | Rove | herdr |
|---|---|---|
| Embedded emulator | `@xterm/headless` | vendored libghostty-vt |
| Kitty graphics APC (`ESC _G`) | discarded by the parser, **no hook exists** | parsed and retained as an image store |
| How images reach the real terminal | they don't | host re-uploads under its own id, re-places clipped to the pane rect, after each frame |

The blocking mechanism in Rove is one line of a dependency:
`EscapeSequenceParser.ts` routes `ESC _` into the APC state with action
`IGNORE`, and the parser has **no APC action** to register a handler
against (`IParser` exposes only CSI / DCS / ESC / OSC). By the time
`xterm-chunks.ts` reads cells, the image never existed. Rove registers no
parser hooks at all today.

So: a capability gap in the emulator, not an architectural one.

## Why we're not switching anyway

1. **herdr ships it off by default**, behind `experimental.kitty_graphics`,
   with docs saying to enable it only when testing terminal image
   behaviour. tmux has no native kitty graphics (a PoC branch, and an open
   debate about whether it's worth it); Zellij has sixel with known
   clearing artifacts. Nobody in this category has made it boring yet.
2. **Reading a CHILD's images stays impossible regardless.** Without
   forking xterm, `icat`, file-manager previews, and anything an engine
   prints in a shell pane remain cells either way. Only Rove's OWN plugins
   could benefit — and their pixels are already in-process, so they never
   needed capture.
3. **The plumbing is cheap; the lifecycle is not.** opentui's `writeOut` +
   public `rendererPtr` make emission possible today, and opentui already
   probes `capabilities.kitty_graphics` / `sixel` / `multiplexer`. The
   expensive part is per-pane image-id namespacing, fingerprint caching,
   source-rect clipping, and explicit deletes on every close / resize /
   scroll / overlay — miss one and images stay burned into the user's
   terminal. Note also that the terminal composites from its own placement
   store, **not** from our cells, so a sidebar drawn "over" a pane does
   not occlude an image; occlusion must be managed by hand.
4. **Cells are correct everywhere** — every terminal, inside tmux, over
   SSH, in VSCode, in recordings. A graphics path is correct on
   kitty/Ghostty/WezTerm and degrades or corrupts elsewhere.

## If this is ever revisited

The cheapest useful increment — do NOT start bigger:

- One internal API shaped like "one image, one rect, host-owned id, delete
  on anything", used by the image plugin only.
- Gated on `renderer.capabilities.kitty_graphics === true` **and**
  `multiplexer === "none"`.
- No streaming, no child capture, no sixel.
- Unsolved prerequisite: **cell pixel size**. A placement needs
  px-per-cell; opentui exposes no such field (herdr reads TIOCGWINSZ with
  an 8×16 fallback), and many terminals report zero. Solve that first or
  images will not line up with pane borders.

Survive a week of pane resizing without leaving garbage behind before
extending it.

## Related

- Half-block rendering is the encoding Rove's pane renders best — see the
  solid-block substitution in `panes/terminal/xterm-chunks.ts` (the
  zebra-stripe fix) and the `kobe.image` / `kobe.video` plugins.
- Sixel (DCS) and iTerm2 inline images (OSC 1337) **are** capturable with
  stock xterm via `registerDcsHandler` / `registerOscHandler`, if a future
  need is specifically about children rather than plugins.
