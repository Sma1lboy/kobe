/**
 * Unit tests for the composer path-preview helpers
 * (`src/tui/chat/composer/path-preview.ts`).
 *
 * Pure string logic: `findPreviewablePathRefs` surfaces only file-list paths
 * that appear as standalone tokens (boundary-guarded so `index.ts` inside
 * `myindex.ts` doesn't match), longest-first so `src/index.ts` wins over
 * `index.ts`; `formatPreviewPathLabel` middle/prefix-truncates to a cell cap.
 */

import { describe, expect, test } from "vitest"
import { findPreviewablePathRefs, formatPreviewPathLabel } from "../../src/tui/chat/composer/path-preview"

describe("findPreviewablePathRefs", () => {
  const files = ["src/index.ts", "index.ts", "README.md"]

  test("finds a standalone path and reports its buffer index", () => {
    const refs = findPreviewablePathRefs("look at src/index.ts please", files)
    expect(refs).toEqual([{ path: "src/index.ts", index: 8 }])
  })

  test("orders results by where they appear, not by file-list order", () => {
    const refs = findPreviewablePathRefs("README.md then src/index.ts", files)
    expect(refs.map((r) => r.path)).toEqual(["README.md", "src/index.ts"])
  })

  test("prefers the longer path when both would match at a position", () => {
    // `src/index.ts` is searched before `index.ts`; once claimed, the shorter
    // one only matches elsewhere — here there is nowhere else, so it drops.
    const refs = findPreviewablePathRefs("edit src/index.ts", files)
    expect(refs.map((r) => r.path)).toEqual(["src/index.ts"])
  })

  test("requires token boundaries — a path glued inside a word is not surfaced", () => {
    expect(findPreviewablePathRefs("myindex.tsx", files)).toEqual([])
    expect(findPreviewablePathRefs("xREADME.md", files)).toEqual([])
  })

  test("allows a trailing sentence-ending period after the path", () => {
    const refs = findPreviewablePathRefs("see README.md.", files)
    expect(refs.map((r) => r.path)).toEqual(["README.md"])
  })

  test("empty text, empty file list, or non-positive limit → no refs", () => {
    expect(findPreviewablePathRefs("   ", files)).toEqual([])
    expect(findPreviewablePathRefs("src/index.ts", [])).toEqual([])
    expect(findPreviewablePathRefs("src/index.ts", files, 0)).toEqual([])
  })

  test("honours the limit", () => {
    const many = ["a.ts", "b.ts", "c.ts"]
    const refs = findPreviewablePathRefs("a.ts b.ts c.ts", many, 2)
    expect(refs).toHaveLength(2)
    expect(refs.map((r) => r.path)).toEqual(["a.ts", "b.ts"])
  })
})

describe("formatPreviewPathLabel", () => {
  test("returns the path untouched when it fits", () => {
    expect(formatPreviewPathLabel("src/a.ts", 20)).toBe("src/a.ts")
  })

  test("hard slices when the cap is too small for an ellipsis", () => {
    expect(formatPreviewPathLabel("src/index.ts", 3)).toBe("src")
    expect(formatPreviewPathLabel("src/index.ts", 0)).toBe("")
  })

  test("keeps the filename and elides the directory prefix when the filename fits", () => {
    const out = formatPreviewPathLabel("packages/kobe/src/tui/Composer.tsx", 20)
    expect(out.endsWith("/Composer.tsx")).toBe(true)
    expect(out).toContain("...")
    expect(out.length).toBeLessThanOrEqual(20)
  })

  test("middle-truncates when even the filename overflows the cap", () => {
    const out = formatPreviewPathLabel("averylongsinglefilename.tsx", 12)
    expect(out).toContain("...")
    expect(out.length).toBeLessThanOrEqual(12)
    expect(out.startsWith("ave")).toBe(true)
  })
})
