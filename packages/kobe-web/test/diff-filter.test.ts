import { describe, expect, it } from "vitest"
import type { DiffFile } from "../src/lib/diff.ts"
import { filterDiffFiles, matchesPath } from "../src/lib/diff-filter.ts"

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

  it("matches a `*` glob anchored to the whole path", () => {
    const gf = [
      file("src/lib/store.ts"),
      file("src/lib/store.test.ts"),
      file("README.md"),
    ]
    // *.test.ts → only the test file (anchored, so store.ts is excluded).
    expect(paths(filterDiffFiles(gf, "*.test.ts"))).toEqual([
      "src/lib/store.test.ts",
    ])
    // src/* → both src files, not README.
    expect(paths(filterDiffFiles(gf, "src/*"))).toEqual([
      "src/lib/store.ts",
      "src/lib/store.test.ts",
    ])
  })

  it("excludes with a leading `!` (negation)", () => {
    // !*.md → everything that isn't markdown.
    expect(paths(filterDiffFiles(files, "!*.md"))).toEqual([
      "src/lib/store.ts",
      "src/components/DiffView.tsx",
    ])
    // !substring negates a plain substring too.
    expect(paths(filterDiffFiles(files, "!src/"))).toEqual(["README.md"])
  })
})

describe("matchesPath", () => {
  it("substring (no glob), case-insensitive", () => {
    expect(matchesPath("src/lib/Store.ts", "store")).toBe(true)
    expect(matchesPath("README.md", "store")).toBe(false)
  })

  it("anchored glob with *", () => {
    expect(matchesPath("a/b/foo.test.ts", "*.test.ts")).toBe(true)
    expect(matchesPath("a/b/foo.test.ts.bak", "*.test.ts")).toBe(false)
    expect(matchesPath("src/x.ts", "src/*")).toBe(true)
    expect(matchesPath("lib/x.ts", "src/*")).toBe(false)
  })

  it("negation flips the result", () => {
    expect(matchesPath("a.json", "!*.json")).toBe(false)
    expect(matchesPath("a.ts", "!*.json")).toBe(true)
  })

  it("an empty or bare-! pattern matches everything", () => {
    expect(matchesPath("anything", "")).toBe(true)
    expect(matchesPath("anything", "!")).toBe(true)
  })

  it("escapes regex metachars in a glob's literal segments", () => {
    // In the glob `a.*` the dot is literal, not 'any char' — so it must match
    // "a." exactly, not "ax".
    expect(matchesPath("a.test.ts", "a.*")).toBe(true)
    expect(matchesPath("axtest", "a.*")).toBe(false)
  })
})
