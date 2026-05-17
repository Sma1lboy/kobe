/**
 * Render an SVG as sixel by converting it to a raster PNG first via
 * `rsvg-convert` and feeding the result into the existing chafa-sixel
 * pipeline. chafa 1.8 doesn't speak SVG natively (its delegated
 * ImageMagick path is unreliable in the snap-style packaging), so we
 * front-end the conversion ourselves.
 *
 * Output sizing: we ask rsvg-convert for a pixel rectangle a few
 * multiples larger than the cell budget so the resulting PNG carries
 * enough resolution for sixel to look crisp — vector content lets us
 * over-sample cheaply, and chafa scales the raster back down to the
 * target cell size during sixel encoding.
 *
 * Returns `null` on any failure (rsvg-convert missing, malformed SVG,
 * I/O error). The caller falls back to the XML syntax-highlight path.
 */

import { spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type SixelResult, renderImageAsSixel } from "./chafa-render"

type ProbedRsvg = { available: boolean }
let probed: ProbedRsvg | null = null

export async function rsvgConvertAvailable(): Promise<boolean> {
  if (probed) return probed.available
  const ok = await new Promise<boolean>((resolve) => {
    const child = spawn("rsvg-convert", ["--version"], { stdio: ["ignore", "ignore", "ignore"] })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
  probed = { available: ok }
  return ok
}

/** Pixel dimensions for the intermediate raster. Higher = sharper but heavier. */
const RASTER_PX_W = 1024
const RASTER_PX_H = 1024

export async function renderSvgAsSixel(absPath: string, maxCols: number, maxRows: number): Promise<SixelResult | null> {
  if (maxCols <= 0 || maxRows <= 0) return null
  if (!(await rsvgConvertAvailable())) return null
  const dir = await mkdtemp(join(tmpdir(), "kobe-svg-"))
  const pngPath = join(dir, "out.png")
  try {
    const ok = await runRsvgConvert(absPath, pngPath)
    if (!ok) return null
    return await renderImageAsSixel(pngPath, maxCols, maxRows)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function runRsvgConvert(absPath: string, outPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [
      "--keep-aspect-ratio",
      "--width",
      String(RASTER_PX_W),
      "--height",
      String(RASTER_PX_H),
      "--output",
      outPath,
      absPath,
    ]
    const child = spawn("rsvg-convert", args, { stdio: ["ignore", "ignore", "pipe"] })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
  })
}
