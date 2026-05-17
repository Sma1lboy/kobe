/**
 * Drive `chafa` for the two image rendering modes the preview pane
 * supports: the **symbols** path (UTF-8 block / sextant / braille
 * character art) and the **sixels** path (raw pixel escapes for
 * Windows Terminal v1.22+, kitty, iTerm2, xterm, mlterm, WezTerm).
 *
 * `renderImageWithChafa(absPath, maxCols, maxRows)` runs
 * `--format=symbols` and parses chafa's ANSI output via
 * {@link parseChafaOutput} into a {@link ChafaGrid} of `{char, fg, bg}`
 * cells. The grid is rendered through opentui's regular text pipeline
 * and is the fallback for terminals without sixel.
 *
 * `renderImageAsSixel(absPath, maxCols, maxRows)` runs
 * `--format=sixels --font-ratio=1/1` and returns the raw escape bytes
 * plus the sixel raster's pixel dimensions (parsed from the
 * `"Pan;Pad;Ph;Pv` raster attributes). The caller writes those bytes
 * to stdout outside opentui's framebuffer via `SixelImageRenderable`.
 *
 * `chafaAvailable()` probes once per process — both rendering modes
 * gate on it so missing chafa falls back to the metadata card with
 * the same shape as the ffmpeg gate.
 *
 * Output discipline for the symbols path: we ask chafa for
 * `--colors=full -O 0` so each cell carries an explicit
 * `\x1b[38;…;48;…m<glyph>\x1b[0m` triple — easy to parse byte-by-byte,
 * no optimization tricks like skipping resets between same-color runs.
 * The parser walks UTF-8 bytes, tracks fg / bg / reverse state via CSI
 * SGR params, and emits one `ChafaCell` per visible grapheme. The
 * `\x1b[7m` reverse flag is collapsed at emit time (we swap fg ↔ bg);
 * chafa uses it for "solid color" cells where the glyph is a space.
 */

import { spawn } from "node:child_process"

/** RGB triple — kept loose so callers can convert to RGBA / `RGBA.fromInts` once. */
export type ChafaRGB = { readonly r: number; readonly g: number; readonly b: number }

export type ChafaCell = {
  /** A single grapheme (1–4 UTF-8 bytes). */
  readonly char: string
  readonly fg: ChafaRGB
  readonly bg: ChafaRGB
}

export type ChafaGrid = {
  readonly cols: number
  readonly rows: number
  readonly cells: readonly (readonly ChafaCell[])[]
}

const BLACK: ChafaRGB = { r: 0, g: 0, b: 0 }

type ProbedChafa = { available: boolean }
let probed: ProbedChafa | null = null

/**
 * One-shot probe for chafa availability. Cached for the process — the
 * binary doesn't appear/disappear at runtime.
 */
export async function chafaAvailable(): Promise<boolean> {
  if (probed) return probed.available
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("chafa", ["--version"], { stdio: ["ignore", "ignore", "ignore"] })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
  probed = { available: ok }
  return ok
}

/** For tests: reset the chafa-availability cache. */
export function _resetChafaProbeCache(): void {
  probed = null
}

/**
 * Render `absPath` to a colored character grid sized to fit within
 * `maxCols` × `maxRows` cells. Returns `null` on any failure (chafa
 * missing, decode error, empty output). chafa preserves aspect ratio
 * by default — the output may be smaller than the budget on one axis.
 */
export async function renderImageWithChafa(
  absPath: string,
  maxCols: number,
  maxRows: number,
): Promise<ChafaGrid | null> {
  if (maxCols <= 0 || maxRows <= 0) return null
  if (!(await chafaAvailable())) return null
  const args = [
    "--format=symbols",
    "--colors=full",
    // No `border`: line glyphs (─│╭╮) produce directional artifacts
    // that read as "mosaic" on photographic images. Stick to symbols
    // that subdivide the cell into colored regions (block / quad /
    // half / sextant for bulk fill, stipple / braille for texture
    // gradients).
    "--symbols=block+space+quad+half+sextant+stipple+dot+braille",
    "--color-space=din99d",
    "--fill=none",
    // -w 9 = "work as hard as possible" — chafa explores more symbol
    // candidates per cell. Worth the few extra ms for a one-shot
    // preview decode.
    "-w",
    "9",
    `--size=${maxCols}x${maxRows}`,
    "-O",
    "0",
    absPath,
  ]
  const out = await runChafa(args)
  if (!out || out.length === 0) return null
  return parseChafaOutput(out)
}

export type SixelResult = {
  /** Raw sixel escape bytes — ready to write at the target cursor position. */
  readonly bytes: Buffer
  /** Image pixel dimensions extracted from the sixel raster attributes. */
  readonly pixelWidth: number
  readonly pixelHeight: number
}

/**
 * Sixel raster attributes follow the DCS Pq with the format
 * `"Pan;Pad;Ph;Pv` (US ASCII `"` then 4 decimal params separated by
 * `;`). Pan/Pad are the pixel aspect numerator / denominator (rarely
 * used); Ph and Pv are the image's pixel width and height. We grab
 * Ph/Pv so the renderable can convert to a WT-cell footprint using
 * an assumed cell pixel size.
 */
function parseSixelRasterDims(buf: Buffer): { pixelWidth: number; pixelHeight: number } | null {
  // Find DCS Pq — `\x1bP...q` — then look for the raster attr starting
  // with `"`. Search a short window (a few hundred bytes is plenty).
  const window = buf.subarray(0, Math.min(512, buf.length)).toString("latin1")
  const dcsIdx = window.indexOf("\x1bP")
  if (dcsIdx < 0) return null
  const qIdx = window.indexOf("q", dcsIdx)
  if (qIdx < 0) return null
  const rest = window.slice(qIdx + 1)
  const m = rest.match(/^"(\d+);(\d+);(\d+);(\d+)/)
  if (!m) return null
  const pixelWidth = Number.parseInt(m[3], 10)
  const pixelHeight = Number.parseInt(m[4], 10)
  if (!Number.isFinite(pixelWidth) || !Number.isFinite(pixelHeight)) return null
  return { pixelWidth, pixelHeight }
}

/**
 * Render `absPath` as a sixel escape sequence sized to fit within
 * `maxCols` × `maxRows` cells. Returns the raw bytes plus the image's
 * actual pixel dimensions (extracted from the sixel raster attributes)
 * so the caller can compute the WT-cell footprint accurately. Returns
 * `null` on any failure.
 *
 * Sixel resolution is pixels per cell, so the upper-bound cell area
 * translates to a far higher pixel count than the symbols path —
 * Windows Terminal v1.22+, kitty, xterm, mlterm, and iTerm2 all
 * render real pixels for this content.
 */
export async function renderImageAsSixel(
  absPath: string,
  maxCols: number,
  maxRows: number,
): Promise<SixelResult | null> {
  if (maxCols <= 0 || maxRows <= 0) return null
  if (!(await chafaAvailable())) return null
  const args = [
    "--format=sixels",
    "--colors=full",
    "--color-space=din99d",
    // For sixel output, chafa's default --font-ratio=1/2 inserts an
    // unwanted vertical squash: sixel pixels render at 1:1 screen
    // pixels (not cell-relative), so the cell-aspect compensation
    // chafa applies for symbols mode is wrong here and makes images
    // look ~2x flatter than the source. Force 1/1 so the output's
    // aspect matches the input.
    "--font-ratio=1/1",
    `--size=${maxCols}x${maxRows}`,
    "-w",
    "9",
    absPath,
  ]
  const out = await runChafa(args)
  if (!out || out.length === 0) return null
  const dims = parseSixelRasterDims(out)
  if (!dims) return null
  return { bytes: out, pixelWidth: dims.pixelWidth, pixelHeight: dims.pixelHeight }
}

function runChafa(args: readonly string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn("chafa", args, { stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.stderr.on("data", () => {
      // discarded — failures surface via the "Preview not supported" copy
    })
    child.on("error", () => resolve(null))
    child.on("close", (code) => {
      if (code !== 0) return resolve(null)
      resolve(Buffer.concat(chunks))
    })
  })
}

/**
 * Walk the byte stream and split into cells. State is per-stream
 * (continues across CSI boundaries but resets on `\x1b[0m`); cells are
 * emitted one per grapheme.
 *
 * Exported for tests — production callers should go through
 * {@link renderImageWithChafa}.
 */
export function parseChafaOutput(buf: Buffer): ChafaGrid {
  let fg: ChafaRGB = BLACK
  let bg: ChafaRGB = BLACK
  let hasFg = false
  let hasBg = false
  let reverse = false
  const rows: ChafaCell[][] = []
  let row: ChafaCell[] = []
  let i = 0
  const len = buf.length
  while (i < len) {
    const b = buf[i]
    if (b === 0x1b /* ESC */ && i + 1 < len && buf[i + 1] === 0x5b /* '[' */) {
      // CSI: parse params + final byte
      let j = i + 2
      const paramsStart = j
      while (j < len) {
        const c = buf[j]
        if (c >= 0x40 && c <= 0x7e /* final byte */) break
        j += 1
      }
      if (j >= len) {
        i = len
        break
      }
      const finalByte = buf[j]
      if (finalByte === 0x6d /* 'm' */) {
        const paramsStr = buf.toString("ascii", paramsStart, j)
        // chafa emits `38;2;R;G;B[;48;2;R;G;B]` in one CSI; we walk the
        // numeric tokens left-to-right and consume in groups.
        const tokens = paramsStr.length === 0 ? [0] : paramsStr.split(";").map((s) => Number.parseInt(s, 10))
        let t = 0
        while (t < tokens.length) {
          const code = tokens[t]
          if (code === 0 || Number.isNaN(code)) {
            // SGR 0 — full reset
            hasFg = false
            hasBg = false
            reverse = false
            fg = BLACK
            bg = BLACK
            t += 1
          } else if (code === 7) {
            reverse = true
            t += 1
          } else if (code === 27) {
            reverse = false
            t += 1
          } else if (code === 39) {
            hasFg = false
            fg = BLACK
            t += 1
          } else if (code === 49) {
            hasBg = false
            bg = BLACK
            t += 1
          } else if (code === 38 && tokens[t + 1] === 2) {
            // 24-bit fg
            fg = {
              r: tokens[t + 2] | 0,
              g: tokens[t + 3] | 0,
              b: tokens[t + 4] | 0,
            }
            hasFg = true
            t += 5
          } else if (code === 48 && tokens[t + 1] === 2) {
            bg = {
              r: tokens[t + 2] | 0,
              g: tokens[t + 3] | 0,
              b: tokens[t + 4] | 0,
            }
            hasBg = true
            t += 5
          } else {
            // unrecognised SGR — skip just this token
            t += 1
          }
        }
      }
      i = j + 1
      continue
    }
    if (b === 0x0a /* '\n' */) {
      rows.push(row)
      row = []
      i += 1
      continue
    }
    if (b === 0x0d /* '\r' */) {
      i += 1
      continue
    }
    // UTF-8 grapheme — gather continuation bytes for one codepoint.
    let glyphEnd = i + 1
    if ((b & 0x80) !== 0) {
      // multibyte: figure out the byte count from the lead byte
      const leadCount = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
      glyphEnd = Math.min(len, i + leadCount)
    }
    const char = buf.toString("utf8", i, glyphEnd)
    const eff = reverse ? { fg: bg, bg: fg } : { fg, bg }
    // If a side never got an explicit color, fall back to black — chafa
    // always emits both sides in our `-O 0` mode, but defensive code
    // here keeps the parser usable on arbitrary inputs.
    row.push({
      char,
      fg: hasFg || reverse ? eff.fg : BLACK,
      bg: hasBg || reverse ? eff.bg : BLACK,
    })
    i = glyphEnd
  }
  if (row.length > 0) rows.push(row)
  const cols = rows.reduce((acc, r) => Math.max(acc, r.length), 0)
  return { cols, rows: rows.length, cells: rows }
}
