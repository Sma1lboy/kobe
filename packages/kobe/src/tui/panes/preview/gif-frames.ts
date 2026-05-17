/**
 * Render an animated GIF as a sequence of chafa-rendered character
 * grids. We shell out to ffmpeg to extract each frame as a PNG into a
 * scratch directory, run chafa on each in sequence, and clean up.
 *
 * Why per-frame PNGs rather than streaming raw RGBA into chafa:
 *   - chafa reads files; piping a concatenated PNG stream through stdin
 *     would still need us to split frames at the JS layer, which is
 *     more error-prone than letting ffmpeg own the splitting.
 *   - The scratch tmpdir is removed in a `finally` block so a partial
 *     failure (chafa crash on frame N) still cleans up.
 *
 * Cap: {@link MAX_FRAMES} frames; longer animations are decimated by
 * letting ffmpeg sample at a matching fps. The MediaBody flip timer
 * uses the returned `frameDelayMs` to pace playback.
 */

import { spawn } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type ChafaGrid, renderImageWithChafa } from "./chafa-render"

/** Hard ceiling on animated-image frame count — keeps memory bounded. */
const MAX_FRAMES = 60
/** Lower bound on per-frame delay — anything faster looks like a stutter. */
const MIN_FRAME_DELAY_MS = 33

export async function renderAnimatedGifWithChafa(
  absPath: string,
  maxCols: number,
  maxRows: number,
): Promise<{ frames: readonly ChafaGrid[]; frameDelayMs: number } | null> {
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
    const frames: ChafaGrid[] = []
    for (const f of files) {
      const grid = await renderImageWithChafa(join(dir, f), maxCols, maxRows)
      if (!grid) return null
      frames.push(grid)
    }
    return { frames, frameDelayMs: Math.max(MIN_FRAME_DELAY_MS, effectiveDelay) }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Probe the GIF for total frame count and mean per-frame delay. Mirrors
 * the previous `probeFrameTiming` in `image-render.ts` — kept inline
 * here so the chafa pipeline doesn't reach back into a module we're
 * about to delete.
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
