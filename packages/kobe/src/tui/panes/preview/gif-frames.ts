/**
 * Render an animated GIF as a sequence of sixel frames. We shell out
 * to ffmpeg to extract each frame as a PNG into a scratch directory,
 * run chafa --format=sixels on each in sequence, and clean up.
 *
 * Why sixel per frame and not the chafa-symbols character grid:
 *   - The static-image path uses sixel for pixel-perfect rendering;
 *     keeping animated GIFs on the symbols path made them look
 *     dramatically different (lower quality + larger cell footprint)
 *     than the static preview right next to them.
 *   - At ~10 fps the per-frame sixel write is ~10–100 KB of stdout
 *     traffic, which the host terminal handles comfortably for a
 *     short animation.
 *
 * Cap: {@link MAX_FRAMES} frames; longer animations are decimated by
 * letting ffmpeg sample at a matching fps. The MediaBody flip timer
 * uses the returned `frameDelayMs` to pace playback.
 */

import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderImageAsSixel } from "./chafa-render"

/** Hard ceiling on animated-image frame count — keeps memory bounded. */
const MAX_FRAMES = 60
/** Lower bound on per-frame delay — anything faster looks like a stutter. */
const MIN_FRAME_DELAY_MS = 33

export type SixelAnimation = {
  readonly frames: readonly Buffer[]
  readonly frameDelayMs: number
  /** Shared pixel dimensions for every frame — determined from frame 0. */
  readonly pixelWidth: number
  readonly pixelHeight: number
}

export async function renderAnimatedGifAsSixel(
  absPath: string,
  maxCols: number,
  maxRows: number,
): Promise<SixelAnimation | null> {
  if (maxCols <= 0 || maxRows <= 0) return null
  const timing = await probeGifTiming(absPath)
  if (!timing) return null
  const dir = await mkdtemp(join(tmpdir(), "kobe-gif-"))
  try {
    const cappedFrames = Math.min(timing.frameCount, MAX_FRAMES)
    const effectiveDelay = (timing.frameDelayMs * timing.frameCount) / cappedFrames
    const filters: string[] = []
    if (cappedFrames < timing.frameCount) {
      // ffmpeg's `fps` filter samples uniformly; chosen so we end up
      // with exactly `cappedFrames` frames spread across the source.
      const sourceFps = 1000 / timing.frameDelayMs
      const targetFps = (sourceFps * cappedFrames) / timing.frameCount
      filters.push(`fps=${targetFps.toFixed(3)}`)
    }
    const ok = await runFfmpegFrames(absPath, dir, cappedFrames, filters)
    if (!ok) return null
    const files = (await readdir(dir)).filter((f) => f.endsWith(".png")).sort()
    if (files.length === 0) return null
    const frames: Buffer[] = []
    let pixelWidth = 0
    let pixelHeight = 0
    for (const f of files) {
      const sixel = await renderImageAsSixel(join(dir, f), maxCols, maxRows)
      if (!sixel) return null
      if (pixelWidth === 0) {
        pixelWidth = sixel.pixelWidth
        pixelHeight = sixel.pixelHeight
      }
      frames.push(sixel.bytes)
    }
    return { frames, frameDelayMs: Math.max(MIN_FRAME_DELAY_MS, effectiveDelay), pixelWidth, pixelHeight }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Probe the GIF for total frame count and mean per-frame delay.
 */
async function probeGifTiming(absPath: string): Promise<{ frameCount: number; frameDelayMs: number } | null> {
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

function runFfmpegFrames(
  absPath: string,
  outDir: string,
  frameCap: number,
  filters: readonly string[],
): Promise<boolean> {
  return new Promise((resolve) => {
    const args = ["-loglevel", "error", "-i", absPath]
    if (filters.length > 0) {
      args.push("-vf", filters.join(","))
    }
    args.push("-frames:v", String(frameCap), "-f", "image2", join(outDir, "frame_%04d.png"))
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
}
