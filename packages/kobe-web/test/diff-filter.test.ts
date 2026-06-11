import { describe, expect, it } from "vitest"
import type { DiffFile } from "../src/lib/diff.ts"
import { filterDiffFiles } from "../src/lib/diff-filter.ts"

/**
 * The Changes pane file filter. A blank query must return the SAME array (the
 * memo no-ops when not searching); otherwise it's a case-insensitive substring
 * match on the path, so typing part of a directory or filename narrows the list.
 */

const file = (path: string): DiffFile =>
  ({ path, status: "modified", patch: "", staged: false }) as DiffFile

const files = [
  file("src/lib/store.ts"),
  file("src/components/DiffView.tsx"),
  file("README.md"),
]

const paths = (fs: readonly DiffFile[]) => fs.map((f) => f.path)

describe("filterDiffFiles", () => {
  it("returns the SAME reference for a blank query", () => {
    expect(filterDiffFiles(files, "")).toBe(files)
    expect(filterDiffFiles(files, "   ")).toBe(files)
  })

  it("matches a path substring case-insensitively", () => {
    expect(paths(filterDiffFiles(files, "STORE"))).toEqual(["src/lib/store.ts"])
  })

  it("narrows by a directory fragment", () => {
    expect(paths(filterDiffFiles(files, "src/"))).toEqual([
      "src/lib/store.ts",
      "src/components/DiffView.tsx",
    ])
  })

  it("matches an extension fragment", () => {
    expect(paths(filterDiffFiles(files, ".tsx"))).toEqual([
      "src/components/DiffView.tsx",
    ])
  })

  it("returns an empty list when nothing matches", () => {
    expect(filterDiffFiles(files, "nope-xyz")).toEqual([])
  })

  it("trims surrounding whitespace from the query", () => {
    expect(paths(filterDiffFiles(files, "  readme  "))).toEqual(["README.md"])
  })
})
