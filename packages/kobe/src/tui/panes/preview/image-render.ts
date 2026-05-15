/**
 * Half-block image rendering for the preview pane (KOB-14, slice 2).
 *
 * Approach: shell out to `ffmpeg` to decode the image and resize it to
 * fit a target character grid, then return raw RGB bytes. The MediaBody
 * renderer turns each pair of pixel rows into one TUI row of `▀` (upper
 * half-block) characters where `fg` is the top pixel and `bg` is the
 * bottom pixel.
 *
 * Why ffmpeg and not a JS decoder:
 *   - Already installed on the user's box (we checked).
 *   - Handles PNG / JPG / GIF / WEBP / BMP / TIFF with the same args.
 *   - Does the resize for us — no need to bundle a JS scaler.
 *   - Pure-JS alternatives (jimp, sharp) add hundreds of KB to MB of
 *     deps for a feature that's already gated on a binary we trust.
 *
 * Why half-block and not sixel / kitty / iTerm protocols:
 *   - opentui owns the screen buffer. Writing raw graphics escapes
 *     inside its frame races with the repaint loop — the image would
 *     vanish on every keystroke until we hooked into the lifecycle.
 *   - Half-blocks render through opentui's native `<text fg bg>` cells
 *     so the image becomes part of the renderable tree like any other
 *     widget. No bypass needed.
 *   - Works in every terminal that supports 24-bit color, not just
 *     WT 1.22+ / kitty / iTerm.
 *
 * Failure modes are absorbed: missing ffmpeg, decode error, or an
 * unparseable image returns null. The caller falls back to the
 * metadata card from slice 1.
 */

import { spawn } from "node:child_process"

/** Aspect-ratio fudge factor — terminal cells are ~2× tall as wide. */
const CELL_ASPECT = 2

/** Hard ceilings — keep one preview from blowing through CPU + memory. */
const MAX_COLS = 200
const MAX_ROWS = 100

export type DecodedImage = {
  /** Final image width in pixels (also character columns in the rendered output). */
  readonly cols: number
  /** Final image height in pixels (always `rows * 2`, since each char holds 2 pixels). */
  readonly pixelRows: number
  /** Tightly packed RGB bytes — cols * pixelRows * 3 of them. */
  readonly rgb: Uint8Array
}

/**
 * Pick output dimensions that fit `(maxCols, maxRows)` character cells
 * while preserving the source aspect ratio (taking the 2:1 cell aspect
 * into account so the rendered image isn't squished vertically).
 *
 * `maxRows` is the TUI row budget; we double it to get the available
 * pixel rows, then scale uniformly. The returned `pixelRows` is always
 * even — the half-block renderer pairs them up.
 */
export function computeTargetDims(
  srcWidth: number,
  srcHeight: number,
  maxCols: number,
  maxRows: number,
): { cols: number; pixelRows: number } {
  if (srcWidth <= 0 || srcHeight <= 0) return { cols: 0, pixelRows: 0 }
  const cols = Math.max(1, Math.min(maxCols, MAX_COLS))
  const pxRowsBudget = Math.max(2, Math.min(maxRows, MAX_ROWS) * CELL_ASPECT)
  // Scale uniformly; each "cell pixel" is 1 col wide and 1 image-pixel tall.
  const scaleW = cols / srcWidth
  const scaleH = pxRowsBudget / srcHeight
  const scale = Math.min(scaleW, scaleH)
  const fittedCols = Math.max(1, Math.floor(srcWidth * scale))
  const rawPxRows = Math.max(2, Math.floor(srcHeight * scale))
  // Force even pixel rows so the half-block pairing is clean.
  const pixelRows = rawPxRows - (rawPxRows % 2)
  return { cols: fittedCols, pixelRows: Math.max(2, pixelRows) }
}

type ProbedFfmpeg = { available: boolean }
let probed: ProbedFfmpeg | null = null

/**
 * One-shot probe for ffmpeg availability. Cached for the process — the
 * binary doesn't appear/disappear at runtime. We don't run `--version`
 * (extra fork on every preview); we let the actual decode call report
 * "spawn ffmpeg ENOENT" instead and surface that once.
 */
export async function ffmpegAvailable(): Promise<boolean> {
  if (probed) return probed.available
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "ignore", "ignore"] })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
  probed = { available: ok }
  return ok
}

/** For tests: reset the ffmpeg-availability cache. */
export function _resetFfmpegProbeCache(): void {
  probed = null
}

/**
 * Decode `absPath` to RGB bytes at the chosen target size. Returns null
 * on any failure — the caller renders the metadata card fallback.
 *
 * `targetCols` and `targetPxRows` come from {@link computeTargetDims}.
 * We pass them verbatim into ffmpeg's `scale=W:H` filter, so the output
 * stream is exactly `cols * pixelRows * 3` bytes — no padding, no
 * variable-length frames, easy to slice.
 */
export async function decodeImage(
  absPath: string,
  targetCols: number,
  targetPxRows: number,
): Promise<DecodedImage | null> {
  if (targetCols <= 0 || targetPxRows <= 0) return null
  if (!(await ffmpegAvailable())) return null
  const args = [
    "-loglevel",
    "error",
    "-i",
    absPath,
    "-vf",
    `scale=${targetCols}:${targetPxRows}:flags=lanczos`,
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "-",
  ]
  const expectedBytes = targetCols * targetPxRows * 3
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let total = 0
    let failed = false
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return
      total += chunk.length
      if (total > expectedBytes) {
        // ffmpeg shouldn't ever overshoot when we ask for a single
        // frame at a fixed scale, but if it does we bail rather than
        // buffer unbounded.
        failed = true
        child.kill("SIGTERM")
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on("data", () => {
      // We never log to stderr from the TUI — ffmpeg diagnostics are
      // discarded. The metadata card communicates failure via "preview
      // unavailable" copy.
    })
    child.on("error", () => resolve(null))
    child.on("close", () => {
      if (failed) return resolve(null)
      const buf = Buffer.concat(chunks)
      if (buf.length !== expectedBytes) return resolve(null)
      resolve({
        cols: targetCols,
        pixelRows: targetPxRows,
        rgb: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
      })
    })
  })
}
