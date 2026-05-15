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
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

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
 * Multi-frame decoded image (animated GIF). Each frame has the same
 * dimensions; only the pixel bytes differ. {@link MediaBody} flips
 * through them on a timer at `frameDelayMs` cadence.
 *
 * We cap frame count at MAX_FRAMES; longer animations are decimated by
 * letting ffmpeg emit at a capped fps. The per-frame redraw cost in
 * opentui (one `<span>` per cell, ~6000 cells for a 100×60 image)
 * outweighs anything finer than ~10 fps anyway.
 */
export type DecodedImageSequence = {
  readonly cols: number
  readonly pixelRows: number
  readonly frames: readonly Uint8Array[]
  readonly frameDelayMs: number
}

/** Hard ceiling on animated-image frame count — keeps memory bounded. */
const MAX_FRAMES = 60
/** Lower bound on per-frame delay — anything faster looks like a stutter in opentui. */
const MIN_FRAME_DELAY_MS = 33

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
/**
 * Run ffmpeg with the supplied argv (which must already specify the
 * input, any seek flags, the `scale` filter, `rgb24` pixel format, and
 * `-f rawvideo -` as the destination) and read exactly `expectedBytes`
 * of stdout. Returns null on any deviation: spawn failure, undersized
 * output, oversized output (we kill the process), or non-zero exit.
 *
 * Shared by every preview decoder so the bytes-per-pixel accounting and
 * cleanup live in one place.
 */
function runFfmpegRawvideo(args: readonly string[], expectedBytes: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    let total = 0
    let failed = false
    child.stdout.on("data", (chunk: Buffer) => {
      if (failed) return
      total += chunk.length
      if (total > expectedBytes) {
        failed = true
        child.kill("SIGTERM")
        return
      }
      chunks.push(chunk)
    })
    child.stderr.on("data", () => {
      // ffmpeg diagnostics are discarded — the media card reports
      // failure via the "preview unavailable" copy.
    })
    child.on("error", () => resolve(null))
    child.on("close", () => {
      if (failed) return resolve(null)
      const buf = Buffer.concat(chunks)
      if (buf.length !== expectedBytes) return resolve(null)
      resolve(buf)
    })
  })
}

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
  const buf = await runFfmpegRawvideo(args, targetCols * targetPxRows * 3)
  if (!buf) return null
  return {
    cols: targetCols,
    pixelRows: targetPxRows,
    rgb: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  }
}

/**
 * Probe a media file for its video-stream dimensions via ffprobe.
 * Used by the video / PDF / unrecognised-image branches that don't
 * have a known header parser. Returns null on spawn failure or
 * unparseable output — caller picks a fallback path.
 *
 * Output format: `ffprobe -of csv=p=0` returns just `W,H` on stdout
 * for a single stream selection. We tolerate extra whitespace and
 * trailing newlines but reject anything else.
 */
export async function probeMediaDims(absPath: string): Promise<{ width: number; height: number } | null> {
  if (!absPath) return null
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", absPath],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    const out: Buffer[] = []
    child.stdout.on("data", (c: Buffer) => out.push(c))
    child.on("error", () => resolve(null))
    child.on("close", (code) => {
      if (code !== 0) return resolve(null)
      const text = Buffer.concat(out).toString("utf8").trim()
      const m = text.match(/^(\d+),(\d+)/)
      if (!m) return resolve(null)
      const width = Number.parseInt(m[1], 10)
      const height = Number.parseInt(m[2], 10)
      if (!width || !height) return resolve(null)
      resolve({ width, height })
    })
  })
}

/**
 * Probe an animated image for its frame count and timing. Returns
 * `null` on failure; the caller can fall back to a static first-frame
 * decode in that case.
 *
 * Strategy: ask ffprobe for `nb_read_frames` (definitive count, needs
 * a full stream scan but for short GIFs is cheap) and `duration`. The
 * mean delay is `duration / nb_read_frames` clamped to a sane floor.
 * We don't try to honour per-frame `delay_time` from the GIF header —
 * the cost of fine-grained timing isn't worth it for a TUI preview.
 */
export async function probeFrameTiming(absPath: string): Promise<{ frameCount: number; frameDelayMs: number } | null> {
  if (!absPath) return null
  return new Promise((resolve) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=nb_read_frames,duration",
        "-of",
        "csv=p=0",
        absPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    const out: Buffer[] = []
    child.stdout.on("data", (c: Buffer) => out.push(c))
    child.on("error", () => resolve(null))
    child.on("close", (code) => {
      if (code !== 0) return resolve(null)
      const text = Buffer.concat(out).toString("utf8").trim()
      // ffprobe with multiple show_entries on the same stream emits
      // them comma-separated on one line. Order matches the request
      // order: `duration,nb_read_frames`. The first scalar in our
      // request was `nb_read_frames` though — but ffprobe reorders to
      // its internal canonical sequence, so we tolerate either order.
      const parts = text.split(/[,\n]/).map((s) => s.trim())
      let frameCount = 0
      let durationSec = 0
      for (const p of parts) {
        const n = Number.parseFloat(p)
        if (!Number.isFinite(n) || n <= 0) continue
        if (Number.isInteger(n) && !frameCount) frameCount = n
        else if (!durationSec) durationSec = n
      }
      if (!frameCount || !durationSec) return resolve(null)
      const mean = (durationSec * 1000) / frameCount
      resolve({ frameCount, frameDelayMs: Math.max(MIN_FRAME_DELAY_MS, mean) })
    })
  })
}

/**
 * Decode every frame of `absPath` (typically an animated GIF) into a
 * fixed-size pixel grid. The output stream is `frameCount` × `cols` ×
 * `pxRows` × 3 bytes; we slice it into per-frame `Uint8Array`s.
 *
 * If `frameCount * cols * pxRows * 3` would exceed the memory cap we
 * leave the result at MAX_FRAMES frames by letting ffmpeg sample at a
 * matching fps via `-vf "fps=…"`. The MediaBody timer cycles through
 * whatever count we end up with at `frameDelayMs` cadence.
 */
export async function decodeAnimatedImage(
  absPath: string,
  targetCols: number,
  targetPxRows: number,
  frameCount: number,
  frameDelayMs: number,
): Promise<DecodedImageSequence | null> {
  if (targetCols <= 0 || targetPxRows <= 0 || frameCount <= 0) return null
  if (!(await ffmpegAvailable())) return null
  const cappedFrames = Math.min(frameCount, MAX_FRAMES)
  // If we decimate, slow down the playback delay proportionally so the
  // total animation duration stays close to the source.
  const effectiveDelay = (frameDelayMs * frameCount) / cappedFrames
  const filters = [`scale=${targetCols}:${targetPxRows}:flags=lanczos`]
  if (cappedFrames < frameCount) {
    // Force ffmpeg to emit exactly `cappedFrames` frames spread across
    // the input — set fps and frame cap so the count is deterministic.
    const sourceFps = (frameCount * 1000) / (frameDelayMs * frameCount) // = 1000/frameDelayMs
    const targetFps = (sourceFps * cappedFrames) / frameCount
    filters.unshift(`fps=${targetFps.toFixed(3)}`)
  }
  const args = [
    "-loglevel",
    "error",
    "-i",
    absPath,
    "-vf",
    filters.join(","),
    "-frames:v",
    String(cappedFrames),
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "-",
  ]
  const frameBytes = targetCols * targetPxRows * 3
  const buf = await runFfmpegRawvideo(args, frameBytes * cappedFrames)
  if (!buf) return null
  const frames: Uint8Array[] = []
  for (let i = 0; i < cappedFrames; i += 1) {
    const start = i * frameBytes
    const slice = buf.subarray(start, start + frameBytes)
    // Copy out of the shared Buffer into an owned Uint8Array so a
    // garbage Buffer release doesn't pull a frame's data out from
    // under the renderer.
    frames.push(new Uint8Array(slice))
  }
  return { cols: targetCols, pixelRows: targetPxRows, frames, frameDelayMs: effectiveDelay }
}

/**
 * Decode the first video frame at `absPath` to RGB. We do an input-side
 * seek (`-ss 0` before `-i`) so ffmpeg jumps to the keyframe at the
 * head of the stream instead of decoding from the start every time;
 * combined with `-frames:v 1` this is the cheapest way to grab a
 * representative thumbnail. Containers that put metadata at the end
 * (like some MP4s) still decode fast enough — single frame is bounded
 * work.
 */
export async function decodeVideoFirstFrame(
  absPath: string,
  targetCols: number,
  targetPxRows: number,
): Promise<DecodedImage | null> {
  if (targetCols <= 0 || targetPxRows <= 0) return null
  if (!(await ffmpegAvailable())) return null
  const args = [
    "-loglevel",
    "error",
    "-ss",
    "0",
    "-i",
    absPath,
    "-frames:v",
    "1",
    "-vf",
    `scale=${targetCols}:${targetPxRows}:flags=lanczos`,
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    "-",
  ]
  const buf = await runFfmpegRawvideo(args, targetCols * targetPxRows * 3)
  if (!buf) return null
  return {
    cols: targetCols,
    pixelRows: targetPxRows,
    rgb: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  }
}

type ProbedPdftoppm = { available: boolean }
let pdftoppmProbed: ProbedPdftoppm | null = null

/**
 * Cached availability probe for pdftoppm (poppler-utils). The binary
 * either exists or it doesn't — the result is cached for the lifetime
 * of the process so we never re-fork to check.
 */
async function pdftoppmAvailable(): Promise<boolean> {
  if (pdftoppmProbed) return pdftoppmProbed.available
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("pdftoppm", ["-v"], { stdio: ["ignore", "ignore", "ignore"] })
    child.on("error", () => resolve(false))
    // pdftoppm -v prints version to stderr and exits 99 (poppler quirk);
    // any non-error spawn is enough for us.
    child.on("close", () => resolve(true))
  })
  pdftoppmProbed = { available: ok }
  return ok
}

/** For tests: reset the pdftoppm-availability cache. */
export function _resetPdftoppmProbeCache(): void {
  pdftoppmProbed = null
}

/**
 * Render the first page of a PDF as a half-block preview. Pipeline:
 *
 *   1. `pdftoppm -png -r 100 -f 1 -l 1 -singlefile` writes one PNG of
 *      page 1 at 100 DPI to a tmpdir (≈ 850×1100 for A4).
 *   2. The existing image decoder takes that PNG and scales it down to
 *      the target half-block grid via ffmpeg.
 *   3. Tmpdir is cleaned up regardless of success or failure.
 *
 * Returns null when pdftoppm is missing, the spawn fails, or the
 * generated PNG can't be decoded. The caller falls back to the
 * "PDF document" metadata card.
 */
export async function decodePdfFirstPage(
  absPath: string,
  targetCols: number,
  targetPxRows: number,
): Promise<DecodedImage | null> {
  if (targetCols <= 0 || targetPxRows <= 0) return null
  if (!(await pdftoppmAvailable())) return null
  const dir = await mkdtemp(path.join(tmpdir(), "kobe-pdf-")).catch(() => null)
  if (!dir) return null
  const pagePath = path.join(dir, "page")
  try {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn("pdftoppm", ["-png", "-r", "100", "-f", "1", "-l", "1", "-singlefile", absPath, pagePath], {
        stdio: ["ignore", "ignore", "ignore"],
      })
      child.on("error", () => resolve(false))
      child.on("close", (code) => resolve(code === 0))
    })
    if (!ok) return null
    return await decodeImage(`${pagePath}.png`, targetCols, targetPxRows)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
