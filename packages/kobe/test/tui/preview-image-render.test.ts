/**
 * Unit tests for preview/image-render.ts.
 *
 * Only the pure helper {@link computeTargetDims} is covered here.
 * `decodeImage` and `ffmpegAvailable` shell out to ffmpeg — they're
 * exercised end-to-end via the preview pane and don't fit the
 * fast-test tier.
 */
import { PIXELS_PER_CELL, computeTargetDims } from "@/tui/panes/preview/image-render"
import { describe, expect, it } from "vitest"

const { x: PX, y: PY } = PIXELS_PER_CELL

describe("computeTargetDims", () => {
  it("fits inside the budget converted from cells to pixels", () => {
    const r = computeTargetDims(300, 168, 60, 30)
    expect(r.cols).toBeLessThanOrEqual(60 * PX)
    expect(r.pixelRows).toBeLessThanOrEqual(30 * PY)
  })

  it("preserves aspect ratio of the source", () => {
    // Square source → square output (both dims clamped by the smaller axis).
    const r = computeTargetDims(100, 100, 40, 40)
    expect(r.cols).toBe(r.pixelRows)
  })

  it("scales a wide source so width matches the col budget", () => {
    // 1920 × 1080 in a 80 × 50 cell budget: pixel budget is 320 × 400.
    // Width is the limiting axis (320 / 1920 < 400 / 1080) so cols snaps
    // to 320 and rows scales by the same factor.
    const r = computeTargetDims(1920, 1080, 80, 50)
    expect(r.cols).toBe(80 * PX)
    // 320 * 1080/1920 = 180 → snap to multiple of PY
    expect(r.pixelRows).toBe(180 - (180 % PY))
  })

  it("scales a tall source so height matches the row budget", () => {
    // 1080 × 1920 in a 100 × 50 cell budget: pixel budget is 400 × 400.
    // Both axes hit the cap at 400; tall source picks the row axis.
    const r = computeTargetDims(1080, 1920, 100, 50)
    expect(r.pixelRows).toBe(50 * PY)
    const expected = Math.floor(50 * PY * (1080 / 1920))
    expect(r.cols).toBe(expected - (expected % PX))
  })

  it("returns zeros for bad input", () => {
    expect(computeTargetDims(0, 100, 60, 30)).toEqual({ cols: 0, pixelRows: 0 })
    expect(computeTargetDims(100, 0, 60, 30)).toEqual({ cols: 0, pixelRows: 0 })
    expect(computeTargetDims(-1, 100, 60, 30)).toEqual({ cols: 0, pixelRows: 0 })
  })

  it("snaps output to the pixels-per-cell grid", () => {
    for (const [w, h, maxC, maxR] of [
      [300, 168, 60, 30],
      [1024, 768, 80, 30],
      [777, 333, 50, 20],
    ] as const) {
      const r = computeTargetDims(w, h, maxC, maxR)
      expect(r.cols % PX).toBe(0)
      expect(r.pixelRows % PY).toBe(0)
    }
  })

  it("clamps the budget at the internal ceilings", () => {
    // Ridiculous budgets should not produce a multi-megapixel grid —
    // the module caps at 800 × 800.
    const r = computeTargetDims(10_000, 10_000, 10_000, 10_000)
    expect(r.cols).toBeLessThanOrEqual(800)
    expect(r.pixelRows).toBeLessThanOrEqual(800)
  })
})
