/**
 * Unit tests for preview/image-render.ts (KOB-14 slice 2).
 *
 * Only the pure helper {@link computeTargetDims} is covered here.
 * `decodeImage` and `ffmpegAvailable` shell out to ffmpeg — they're
 * exercised end-to-end via the preview pane and don't fit the
 * fast-test tier.
 */
import { computeTargetDims } from "@/tui/panes/preview/image-render"
import { describe, expect, it } from "vitest"

describe("computeTargetDims", () => {
  it("returns a target that fits inside the given budget", () => {
    const r = computeTargetDims(300, 168, 60, 30)
    expect(r.cols).toBeLessThanOrEqual(60)
    // pixel rows budget = 30 cells × 2 px/cell = 60
    expect(r.pixelRows).toBeLessThanOrEqual(60)
  })

  it("preserves aspect ratio accounting for the 2:1 cell aspect", () => {
    // Square image (1:1 pixel aspect) should produce half as many cell
    // rows as cols, because each cell holds 2 pixel rows.
    const r = computeTargetDims(100, 100, 40, 40)
    // square pixels: cols == pixelRows (both 1:1 in pixel space)
    expect(r.cols).toBe(r.pixelRows)
  })

  it("scales down a wider-than-tall image to fit cols", () => {
    // 16:9-ish image (1920 × 1080). With 80 col budget the height
    // budget is 80 × 1080/1920 = 45 pixel rows.
    const r = computeTargetDims(1920, 1080, 80, 50)
    expect(r.cols).toBe(80)
    // 80 × 1080/1920 = 45
    expect(r.pixelRows).toBe(44) // 45 rounded down to even
  })

  it("scales down a taller-than-wide image to fit rows", () => {
    // 9:16 image (1080 × 1920). With 50 row budget (= 100 px tall), width
    // scales to 100 × 1080/1920 = 56.25 → 56.
    const r = computeTargetDims(1080, 1920, 100, 50)
    expect(r.pixelRows).toBe(100)
    expect(r.cols).toBe(56)
  })

  it("returns zeros for bad input", () => {
    expect(computeTargetDims(0, 100, 60, 30)).toEqual({ cols: 0, pixelRows: 0 })
    expect(computeTargetDims(100, 0, 60, 30)).toEqual({ cols: 0, pixelRows: 0 })
    expect(computeTargetDims(-1, 100, 60, 30)).toEqual({ cols: 0, pixelRows: 0 })
  })

  it("always returns even pixel rows so half-block pairing is clean", () => {
    for (const [w, h, maxC, maxR] of [
      [300, 168, 60, 30],
      [1024, 768, 80, 30],
      [777, 333, 50, 20],
    ] as const) {
      const r = computeTargetDims(w, h, maxC, maxR)
      expect(r.pixelRows % 2).toBe(0)
    }
  })

  it("clamps the budget at the internal ceilings", () => {
    // Asking for ridiculous budgets should not produce a multi-megapixel
    // grid — the module caps at 200 × 100.
    const r = computeTargetDims(10_000, 10_000, 10_000, 10_000)
    expect(r.cols).toBeLessThanOrEqual(200)
    expect(r.pixelRows).toBeLessThanOrEqual(200) // 100 rows × 2
  })
})
