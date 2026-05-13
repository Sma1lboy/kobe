import { describe, expect, test } from "vitest"
import { findPreviewablePathRefs, formatPreviewPathLabel } from "../../src/tui/panes/chat/composer/path-preview"

describe("findPreviewablePathRefs", () => {
  const files = [
    "README.md",
    "packages/kobe/src/tui/panes/chat/Composer.tsx",
    "packages/kobe/src/tui/panes/chat/Chat.tsx",
    "src/index.ts",
    "index.ts",
  ]

  test("finds existing worktree-relative paths in typed text order", () => {
    const refs = findPreviewablePathRefs("compare packages/kobe/src/tui/panes/chat/Chat.tsx with README.md", files)

    expect(refs.map((r) => r.path)).toEqual(["packages/kobe/src/tui/panes/chat/Chat.tsx", "README.md"])
  })

  test("accepts @file mentions and trailing punctuation", () => {
    const refs = findPreviewablePathRefs("please inspect @packages/kobe/src/tui/panes/chat/Composer.tsx.", files)

    expect(refs.map((r) => r.path)).toEqual(["packages/kobe/src/tui/panes/chat/Composer.tsx"])
  })

  test("does not surface substrings that are not standalone path references", () => {
    const refs = findPreviewablePathRefs("this mentions mysrc/index.tsx and README.md.backup", files)

    expect(refs).toEqual([])
  })

  test("prefers the longer path when nested names overlap", () => {
    const refs = findPreviewablePathRefs("open src/index.ts, not just index.ts", files)

    expect(refs.map((r) => r.path)).toEqual(["src/index.ts", "index.ts"])
  })

  test("deduplicates repeated references and honors the limit", () => {
    const refs = findPreviewablePathRefs(
      "README.md packages/kobe/src/tui/panes/chat/Chat.tsx README.md packages/kobe/src/tui/panes/chat/Composer.tsx",
      files,
      2,
    )

    expect(refs.map((r) => r.path)).toEqual(["README.md", "packages/kobe/src/tui/panes/chat/Chat.tsx"])
  })
})

describe("formatPreviewPathLabel", () => {
  test("keeps short labels intact", () => {
    expect(formatPreviewPathLabel("README.md", 20)).toBe("README.md")
  })

  test("compacts long paths while preserving the filename", () => {
    expect(formatPreviewPathLabel("packages/kobe/src/tui/panes/chat/Composer.tsx", 24)).toBe("packages.../Composer.tsx")
  })

  test("compacts long filenames when the basename cannot fit", () => {
    expect(formatPreviewPathLabel("really-long-file-name-without-directories.ts", 18)).toBe("really-...ories.ts")
  })
})
