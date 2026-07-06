/**
 * SGR (Select Graphic Rendition) parser for the terminal pane.
 *
 * The terminal pane historically forwarded pipe stdout/stderr into
 * this parser. The default backend now uses `@xterm/headless` first,
 * so snapshots are already terminal-emulated text; this parser remains
 * as a light styling layer for any SGR that reaches the render path and
 * for the explicit pipe fallback backend.
 *
 * Reference for SGR semantics:
 *   - ECMA-48 §8.3.117
 *   - https://en.wikipedia.org/wiki/ANSI_escape_code#SGR
 *
 * Parser is pure / Solid-free / opentui-free except for the RGBA
 * helpers it uses for color conversion. Unit-tested in
 * `test/tui/terminal-sgr.test.ts`.
 */

import { parse } from "@ansi-tools/parser"

/**
 * RGB triple in 0-255 ints. Used in place of opentui's RGBA so this
 * file has zero opentui dependency — that lets vitest load it without
 * dragging in opentui's tree-sitter `.scm` assets (which vitest's
 * default loader refuses on sight). The thin adapter in
 * `./sgr-to-text-chunk.ts` converts RGB → RGBA at render time.
 */
export type RGB = readonly [r: number, g: number, b: number]

/**
 * Attribute bitmask values. Intentionally match opentui's
 * `TextAttributes` enum (BOLD=1, DIM=2, ITALIC=4, …) so a chunk
 * produced here can be handed straight to a `TextChunk` consumer
 * without remapping. Hard-coded rather than imported from opentui
 * for the same vitest reason described on RGB above.
 */
export const ATTR = Object.freeze({
  BOLD: 1, // 1 << 0
  DIM: 2, // 1 << 1
  ITALIC: 4, // 1 << 2
  UNDERLINE: 8, // 1 << 3
  BLINK: 16, // 1 << 4
  INVERSE: 32, // 1 << 5
  HIDDEN: 64, // 1 << 6
  STRIKETHROUGH: 128, // 1 << 7
})

export interface Style {
  fg: RGB | undefined
  bg: RGB | undefined
  attributes: number
}

export interface Chunk {
  readonly text: string
  readonly fg?: RGB
  readonly bg?: RGB
  readonly attributes?: number
}

export const EMPTY_STYLE: Style = Object.freeze({
  fg: undefined,
  bg: undefined,
  attributes: 0,
})

/**
 * Inline ANSI 256-color palette. The first 16 entries are the xterm
 * defaults for the standard / bright system colors; entries 16-231
 * are the 6×6×6 RGB cube; entries 232-255 are the 24-step grayscale
 * ramp. Reference: https://en.wikipedia.org/wiki/ANSI_escape_code#8-bit
 *
 * We don't import opentui's `ansi256IndexToRgb` because that would
 * pull opentui's full module graph into the test runtime (see file
 * top-of-comment for why we keep this file opentui-free).
 */
export function ansi256ToRgb(index: number): RGB {
  if (index < 0) return [0, 0, 0]
  if (index < 16) return SYSTEM_PALETTE[index] ?? [0, 0, 0]
  if (index < 232) {
    // 6x6x6 cube. cube_step[0..5] = {0, 95, 135, 175, 215, 255} —
    // matches xterm's published table.
    const i = index - 16
    const r = Math.floor(i / 36)
    const g = Math.floor((i / 6) % 6)
    const b = i % 6
    const step = (n: number) => (n === 0 ? 0 : 55 + 40 * n)
    return [step(r), step(g), step(b)]
  }
  if (index < 256) {
    // Grayscale ramp. 24 entries from #080808 to #eeeeee, step 10.
    const gray = 8 + 10 * (index - 232)
    return [gray, gray, gray]
  }
  return [0, 0, 0]
}

/**
 * Basic-16 ANSI palette (indices 0-15). Ls/eza color a directory or
 * symlink with a BARE ANSI code (30-37/90-97), not truecolor — the actual
 * displayed hue is always "whatever this terminal's theme maps that slot
 * to," which is why the embedded terminal's picks matter here even though
 * they'll never byte-match a user's personal terminal profile.
 *
 * Previously the textbook xterm defaults (pure blue `#0000EE`, pure
 * magenta `#CD00CD`, …). Every ANSI slot kept its "expected" hue in
 * isolation, but real terminal themes commonly cluster several slots
 * (blue/cyan/bright-magenta) into one accent family — e.g. `ls`'s `di`
 * (directory, blue) and `ln` (symlink, cyan) read as the same violet in a
 * themed iTerm2 profile, but as two distinct colors against the stock
 * palette (KOB, 2026-07-06: reported as "kobe renders these wrong," not a
 * decode bug — `ansi256ToRgb`/truecolor decode is bit-exact, verified).
 *
 * Replaced with Tokyo Night's published terminal ANSI colors (a popular
 * modern scheme, also one of kobe's own bundled UI themes) so the
 * embedded terminal's defaults read as one coherent, contemporary palette
 * instead of xterm's 1990s primaries.
 */
const SYSTEM_PALETTE: readonly RGB[] = [
  [21, 22, 30], // black       #15161e
  [247, 118, 142], // red      #f7768e
  [158, 206, 106], // green    #9ece6a
  [224, 175, 104], // yellow   #e0af68
  [122, 162, 247], // blue     #7aa2f7
  [187, 154, 247], // magenta  #bb9af7
  [125, 207, 255], // cyan     #7dcfff
  [169, 177, 214], // white    #a9b1d6
  [65, 72, 104], // bright black    #414868
  [255, 137, 157], // bright red    #ff899d
  [158, 224, 68], // bright green   #9ee044
  [250, 186, 74], // bright yellow  #faba4a
  [141, 176, 255], // bright blue   #8db0ff
  [199, 169, 255], // bright magenta #c7a9ff
  [164, 218, 255], // bright cyan   #a4daff
  [192, 202, 245], // bright white  #c0caf5
]

/**
 * Apply one SGR escape's params to the running style, returning the
 * new style. Unknown params are silently ignored — better to render
 * "missing one color" than to crash on a malformed escape.
 *
 * Each escape can chain multiple SGR ops: `\x1b[1;31;48;5;238m` =
 * bold + red fg + 256-color bg. We walk the params array linearly.
 * Extended-color introducers (38, 48) consume their follow-up params
 * before continuing the walk.
 */
function applySgr(prev: Style, rawParams: readonly string[]): Style {
  // Empty params (just `\x1b[m`) means reset, same as `\x1b[0m`.
  const params: number[] =
    rawParams.length === 0 ? [0] : rawParams.map((p) => (p === "" ? 0 : Number.parseInt(p, 10) || 0))
  let fg = prev.fg
  let bg = prev.bg
  let attr = prev.attributes
  let i = 0
  while (i < params.length) {
    const p = params[i]
    if (p === undefined) break
    // Reset everything.
    if (p === 0) {
      fg = undefined
      bg = undefined
      attr = 0
      i += 1
      continue
    }
    // Single-byte attribute toggles.
    if (p === 1) {
      attr |= ATTR.BOLD
      i += 1
      continue
    }
    if (p === 2) {
      attr |= ATTR.DIM
      i += 1
      continue
    }
    if (p === 3) {
      attr |= ATTR.ITALIC
      i += 1
      continue
    }
    if (p === 4) {
      attr |= ATTR.UNDERLINE
      i += 1
      continue
    }
    if (p === 5 || p === 6) {
      attr |= ATTR.BLINK
      i += 1
      continue
    }
    if (p === 7) {
      attr |= ATTR.INVERSE
      i += 1
      continue
    }
    if (p === 8) {
      attr |= ATTR.HIDDEN
      i += 1
      continue
    }
    if (p === 9) {
      attr |= ATTR.STRIKETHROUGH
      i += 1
      continue
    }
    // Attribute resets.
    if (p === 22) {
      attr &= ~(ATTR.BOLD | ATTR.DIM)
      i += 1
      continue
    }
    if (p === 23) {
      attr &= ~ATTR.ITALIC
      i += 1
      continue
    }
    if (p === 24) {
      attr &= ~ATTR.UNDERLINE
      i += 1
      continue
    }
    if (p === 25) {
      attr &= ~ATTR.BLINK
      i += 1
      continue
    }
    if (p === 27) {
      attr &= ~ATTR.INVERSE
      i += 1
      continue
    }
    if (p === 28) {
      attr &= ~ATTR.HIDDEN
      i += 1
      continue
    }
    if (p === 29) {
      attr &= ~ATTR.STRIKETHROUGH
      i += 1
      continue
    }
    // Standard fg (30-37) / bright fg (90-97).
    if (p >= 30 && p <= 37) {
      fg = ansi256ToRgb(p - 30)
      i += 1
      continue
    }
    if (p >= 90 && p <= 97) {
      fg = ansi256ToRgb(p - 90 + 8)
      i += 1
      continue
    }
    // Default fg.
    if (p === 39) {
      fg = undefined
      i += 1
      continue
    }
    // Standard bg (40-47) / bright bg (100-107).
    if (p >= 40 && p <= 47) {
      bg = ansi256ToRgb(p - 40)
      i += 1
      continue
    }
    if (p >= 100 && p <= 107) {
      bg = ansi256ToRgb(p - 100 + 8)
      i += 1
      continue
    }
    // Default bg.
    if (p === 49) {
      bg = undefined
      i += 1
      continue
    }
    // Extended fg. Two introducer forms:
    //   - 38;5;N        — 256-color palette (3 params total)
    //   - 38;2;R;G;B    — true-color, legacy semicolon shape (5 params)
    //
    // We deliberately parse the legacy 5-param shape. The optional ITU
    // T.416 colorspace id (the 6-param `38;2;ID;R;G;B`) only exists in
    // the colon-subparameter form in practice; semicolon-delimited SGR
    // is universally R;G;B. `parseAnsiLine` feeds us params split from
    // the raw escape (see `sgrParamsFromRaw`) precisely so no phantom
    // colorspace id can shift the RGB triple here.
    if (p === 38) {
      const sub = params[i + 1]
      if (sub === 5) {
        const idx = params[i + 2] ?? 0
        fg = ansi256ToRgb(idx)
        i += 3
        continue
      }
      if (sub === 2) {
        const r = params[i + 2] ?? 0
        const g = params[i + 3] ?? 0
        const b = params[i + 4] ?? 0
        fg = [r, g, b]
        i += 5
        continue
      }
      // Malformed — skip the introducer and try to recover.
      i += 1
      continue
    }
    // Extended bg, same structure as fg.
    if (p === 48) {
      const sub = params[i + 1]
      if (sub === 5) {
        const idx = params[i + 2] ?? 0
        bg = ansi256ToRgb(idx)
        i += 3
        continue
      }
      if (sub === 2) {
        const r = params[i + 2] ?? 0
        const g = params[i + 3] ?? 0
        const b = params[i + 4] ?? 0
        bg = [r, g, b]
        i += 5
        continue
      }
      i += 1
      continue
    }
    // Unknown param — skip and continue. Don't bail; the next param
    // might still be meaningful.
    i += 1
  }
  return { fg, bg, attributes: attr }
}

/**
 * Split an SGR escape's parameter list straight from its raw bytes.
 *
 * We do NOT trust `@ansi-tools/parser`'s pre-split `params`: for a bare
 * single true-color escape like `\x1b[38;2;R;G;B m` it injects a
 * phantom ITU colorspace id (`38;2;0;R;G;B`), but it does NOT inject
 * one when the introducer is chained (`\x1b[0;38;2;R;G;B m`,
 * `\x1b[1;38;2;R;G;B m`). That inconsistency can't be undone from the
 * split values alone, and it shifted the RGB triple by one — every
 * true-color cell rendered the wrong hue. Re-splitting the raw escape
 * gives the uniform legacy `R;G;B` shape regardless of chaining.
 *
 * Strips the CSI introducer (`\x1b[` or the 1-byte `\x9b`) and the
 * trailing `m`, then splits on `;`. Empty body (`\x1b[m`) yields `[""]`,
 * which `applySgr` treats as a reset — same as `\x1b[0m`.
 */
function sgrParamsFromRaw(raw: string): string[] {
  // String slicing rather than a regex: the CSI introducers are control
  // characters (ESC 0x1b, 1-byte CSI 0x9b), which a regex literal can't
  // carry under our lint rules. Strip the introducer + trailing `m`.
  let body = raw
  if (body.charCodeAt(0) === 0x1b)
    body = body.slice(2) // ESC `[`
  else if (body.charCodeAt(0) === 0x9b) body = body.slice(1) // 1-byte CSI
  if (body.endsWith("m")) body = body.slice(0, -1)
  return body.split(";")
}

/**
 * Parse one line of text containing SGR escapes into a list of style
 * runs. Caller passes the carry-in style (the style state at the end
 * of the previous line).
 *
 * Returned chunks are ready to feed into a `StyledText`:
 *   `new StyledText(parseAnsiLine(s, style).map(toTextChunk))`
 */
export function parseAnsiLine(input: string, initial: Style = EMPTY_STYLE): { chunks: Chunk[]; endStyle: Style } {
  if (input.length === 0) return { chunks: [], endStyle: initial }
  const out: Chunk[] = []
  let style: Style = { ...initial }
  let buf = ""
  const flush = () => {
    if (buf.length === 0) return
    const c: Chunk = {
      text: buf,
      ...(style.fg ? { fg: style.fg } : {}),
      ...(style.bg ? { bg: style.bg } : {}),
      ...(style.attributes !== 0 ? { attributes: style.attributes } : {}),
    }
    out.push(c)
    buf = ""
  }
  const codes = parse(input)
  for (const code of codes) {
    if (code.type === "TEXT") {
      buf += code.raw
      continue
    }
    // SGR escapes come back from @ansi-tools/parser as CSI codes
    // with command "m" — the parser doesn't separately label SGR, it
    // just exposes the raw CSI envelope. Anything else with type
    // "CSI" (cursor motion, erase-in-line, etc.) is either already
    // handled by @xterm/headless or unsupported in the pipe fallback;
    // we drop those rather than rendering raw bytes.
    if (code.type === "CSI" && code.command === "m") {
      flush()
      style = applySgr(style, sgrParamsFromRaw(code.raw))
    }
    // Any other control code we let through as raw text is silently
    // dropped. If a stray OSC / CSI slips through, dropping it is safer
    // than rendering its raw bytes.
  }
  flush()
  return { chunks: out, endStyle: style }
}

/**
 * Parse a full multi-line snapshot into one chunk-list per row.
 * Splits on `\n`. Carries SGR state across line breaks because shell
 * output can keep a single style state across multiple rows.
 *
 * Empty trailing lines (from a stripped-final-newline capture) are
 * preserved so cursor-capable backends can index into the returned
 * array 1:1.
 */
export function parseAnsiSnapshot(input: string): Chunk[][] {
  const lines = input.split("\n")
  const rows: Chunk[][] = []
  let carry: Style = EMPTY_STYLE
  for (const line of lines) {
    const { chunks, endStyle } = parseAnsiLine(line, carry)
    rows.push(chunks)
    carry = endStyle
  }
  return rows
}
