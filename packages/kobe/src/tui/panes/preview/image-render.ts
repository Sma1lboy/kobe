/**
 * Pixel image decoding for the preview pane.
 *
 * Approach: shell out to `ffmpeg` to decode the image and resize it to
 * fit a target pixel grid, then return raw RGBA bytes. The MediaBody
 * hands the buffer to `PixelImageRenderable`, which calls opentui's
 * native `drawSuperSampleBuffer`.
 *
 * Cell mapping: opentui's `drawSuperSampleBuffer` is hard-coded in the
 * Zig backend to 2 pixels per cell in both axes — it picks one of the
 * 16 quadrant block glyphs (U+2596..U+259F + half-blocks) per cell,
 * assigning fg/bg from the 4 sub-pixels. So our pixel buffer must be
 * exactly `cellCols * 2` wide × `cellRows * 2` tall; anything denser
 * just makes the image render at a larger cell footprint than we
 * declared. Real sixel / kitty graphics would need a separate code
 * path that opentui doesn't expose today.
 *
 * Why ffmpeg and not a JS decoder:
 *   - Already installed on the user's box (we checked).
 *   - Handles PNG / JPG / GIF / WEBP / BMP / TIFF with the same args.
 *   - Does the resize for us — no need to bundle a JS scaler.
 *   - Pure-JS alternatives (jimp, sharp) add hundreds of KB to MB of
 *     deps for a feature that's already gated on a binary we trust.
 *
 * Failure modes are absorbed: missing ffmpeg, decode error, or an
 * unparseable image returns null. The caller falls back to the
 * metadata card.
 */

import { spawn } from "node:child_process"

/**
 * Pixels per terminal cell — must match the Zig backend's hard-coded
 * quadrant supersample ratio (2 × 2). Any other value will make the
 * rendered image overflow the cell footprint claimed by the renderable
 * by the same factor.
 */
const PIXELS_PER_CELL_X = 2
const PIXELS_PER_CELL_Y = 2

/** Hard ceilings on the resulting pixel grid — keep memory bounded. */
const MAX_PIXEL_COLS = 400
const MAX_PIXEL_ROWS = 200

export type DecodedImage = {
  /** Final image width in pixels. */
  readonly cols: number
  /** Final image height in pixels. */
  readonly pixelRows: number
  /** Tightly packed RGBA bytes — cols * pixelRows * 4 of them. */
  readonly rgba: Uint8Array
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
 * Pick output dimensions in *pixels* that fit `(maxCols, maxRows)`
 * character cells while preserving the source aspect ratio.
 *
 * We oversample each cell by `(PIXELS_PER_CELL_X, PIXELS_PER_CELL_Y)`
 * so the Zig backend has real pixels to feed into sixel / kitty
 * graphics protocols. Output is clamped to {@link MAX_PIXEL_COLS} /
 * {@link MAX_PIXEL_ROWS} so a single preview can't blow through
 * memory.
 *
 * The `cols` field here is *pixel columns* (not character columns) —
 * the renderable lays itself out in cells using
 * `cols / PIXELS_PER_CELL_X` and `pixelRows / PIXELS_PER_CELL_Y`.
 */
export function computeTargetDims(
  srcWidth: number,
  srcHeight: number,
  maxCols: number,
  maxRows: number,
): { cols: number; pixelRows: number } {
  if (srcWidth <= 0 || srcHeight <= 0) return { cols: 0, pixelRows: 0 }
  const pxColsBudget = Math.max(PIXELS_PER_CELL_X, Math.min(maxCols * PIXELS_PER_CELL_X, MAX_PIXEL_COLS))
  const pxRowsBudget = Math.max(PIXELS_PER_CELL_Y, Math.min(maxRows * PIXELS_PER_CELL_Y, MAX_PIXEL_ROWS))
  const scaleW = pxColsBudget / srcWidth
  const scaleH = pxRowsBudget / srcHeight
  const scale = Math.min(scaleW, scaleH)
  const rawCols = Math.max(1, Math.floor(srcWidth * scale))
  const rawRows = Math.max(1, Math.floor(srcHeight * scale))
  // Snap to the cell grid so layout integer-math stays clean.
  const cols = Math.max(PIXELS_PER_CELL_X, rawCols - (rawCols % PIXELS_PER_CELL_X))
  const pixelRows = Math.max(PIXELS_PER_CELL_Y, rawRows - (rawRows % PIXELS_PER_CELL_Y))
  return { cols, pixelRows }
}

/** Pixel-per-cell factors, so renderers can convert pixel dims back to cells. */
export const PIXELS_PER_CELL = { x: PIXELS_PER_CELL_X, y: PIXELS_PER_CELL_Y } as const

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
 * Run ffmpeg with the supplied argv (which must already specify the
 * input, any seek flags, the `scale` filter, the pixel format, and
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

/**
 * Decode `absPath` to RGBA bytes at the chosen target size. Returns
 * `null` on any failure — the caller renders the metadata card fallback.
 *
 * `targetCols` and `targetPxRows` come from {@link computeTargetDims}.
 * We pass them verbatim into ffmpeg's `scale=W:H` filter, so the output
 * stream is exactly `cols * pixelRows * 4` bytes — no padding, no
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
    "rgba",
    "-f",
    "rawvideo",
    "-",
  ]
  const buf = await runFfmpegRawvideo(args, targetCols * targetPxRows * 4)
  if (!buf) return null
  return {
    cols: targetCols,
    pixelRows: targetPxRows,
    rgba: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  }
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
 * fixed-size RGBA pixel grid. The output stream is `frameCount` ×
 * `cols` × `pxRows` × 4 bytes; we slice it into per-frame
 * `Uint8Array`s.
 *
 * If `frameCount` exceeds {@link MAX_FRAMES} we cap by letting ffmpeg
 * sample at a matching fps via `-vf "fps=…"`. The MediaBody timer
 * cycles through whatever count we end up with at `frameDelayMs`
 * cadence.
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
    "rgba",
    "-f",
    "rawvideo",
    "-",
  ]
  const frameBytes = targetCols * targetPxRows * 4
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
