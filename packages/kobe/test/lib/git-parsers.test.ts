/**
 * Unit tests for the shared git porcelain/numstat parser
 * (`src/lib/git-parsers.ts`).
 *
 * The hard cases — verified against real `git status --porcelain` /
 * `git diff --numstat` output — are:
 *   - C-string unquoting: git wraps any path with a space (porcelain
 *     renames), a tab/newline/quote, or a non-ASCII byte in a double-quoted,
 *     C-escaped string, and emits non-ASCII as three-digit OCTAL bytes
 *     (`\303\274` = the UTF-8 bytes of `ü`).
 *   - rename resolution: porcelain uses ` -> ` with each side quoted
 *     independently; numstat uses ` => ` and brace-compacts unchanged
 *     segments (`src/{old => new}`) ONLY when neither side needs quoting,
 *     else falls back to independently-quoted `"a\tb" => "a\tc"`.
 *   - the join: porcelain quotes a spaced path (`"a b.txt"`) while numstat
 *     does not (`a b.txt`); unquoting BOTH yields one canonical path so a
 *     renamed/modified spaced file's numstat counts key onto its status row.
 */

import { describe, expect, test } from "vitest"
import { type NumstatRow, parseNumstatRows, parsePorcelainRows, unquoteGitPath } from "../../src/lib/git-parsers"

describe("unquoteGitPath", () => {
  test("returns an unquoted path verbatim", () => {
    expect(unquoteGitPath("src/app.ts")).toBe("src/app.ts")
  })

  test("returns the empty string verbatim", () => {
    expect(unquoteGitPath("")).toBe("")
  })

  test("strips the wrapping quotes off a quoted path", () => {
    expect(unquoteGitPath('"has space.txt"')).toBe("has space.txt")
  })

  test("decodes \\t / \\n escapes to real control chars", () => {
    expect(unquoteGitPath('"weird\\tname.txt"')).toBe("weird\tname.txt")
    expect(unquoteGitPath('"line\\nbreak.txt"')).toBe("line\nbreak.txt")
  })

  test("decodes the full C-escape set (\\a \\b \\v \\f \\r)", () => {
    expect(unquoteGitPath('"a\\ab\\bv\\vf\\fr\\r"')).toBe("a\x07b\x08v\x0bf\x0cr\r")
  })

  test("decodes escaped quote and backslash", () => {
    expect(unquoteGitPath('"a\\"b\\\\c.txt"')).toBe('a"b\\c.txt')
  })

  test("decodes octal byte escapes as UTF-8 (ü)", () => {
    expect(unquoteGitPath('"\\303\\274nicode.txt"')).toBe("ünicode.txt")
  })

  test("decodes a multi-byte octal run mixed with ASCII", () => {
    // "\303\274n\303\257code.txt" → ü n ï code.txt
    expect(unquoteGitPath('"\\303\\274n\\303\\257code.txt"')).toBe("ünïcode.txt")
  })

  test("an unknown escape keeps the escaped char literally", () => {
    expect(unquoteGitPath('"a\\zb"')).toBe("azb")
  })

  test("a path that merely contains a quote mid-string (unquoted) is verbatim", () => {
    expect(unquoteGitPath('a"b.txt')).toBe('a"b.txt')
  })
})

describe("parsePorcelainRows", () => {
  test("parses index/worktree status pairs and untracked", () => {
    const raw = [" M src/a.ts", "M  src/b.ts", "A  src/c.ts", "?? src/d.ts", ""].join("\n")
    expect(parsePorcelainRows(raw)).toEqual([
      { x: " ", y: "M", path: "src/a.ts" },
      { x: "M", y: " ", path: "src/b.ts" },
      { x: "A", y: " ", path: "src/c.ts" },
      { x: "?", y: "?", path: "src/d.ts" },
    ])
  })

  test("skips the branch-header line and blank/short lines", () => {
    const raw = ["## main...origin/main [ahead 2]", "", "x", " M ok.ts"].join("\n")
    expect(parsePorcelainRows(raw)).toEqual([{ x: " ", y: "M", path: "ok.ts" }])
  })

  test("preserves merge-conflict XY pairs (UU / AA / DD)", () => {
    const raw = ["UU both.ts", "AA added.ts", "DD gone.ts"].join("\n")
    expect(parsePorcelainRows(raw)).toEqual([
      { x: "U", y: "U", path: "both.ts" },
      { x: "A", y: "A", path: "added.ts" },
      { x: "D", y: "D", path: "gone.ts" },
    ])
  })

  test("resolves a rename: new path quoted, old path bare", () => {
    expect(parsePorcelainRows('R  normal.txt -> "renamed normal.txt"')).toEqual([
      { x: "R", y: " ", path: "renamed normal.txt", origPath: "normal.txt" },
    ])
  })

  test("resolves a rename with both sides quoted (spaces)", () => {
    expect(parsePorcelainRows('R  "spaced name.txt" -> "sub/spaced name.txt"')).toEqual([
      { x: "R", y: " ", path: "sub/spaced name.txt", origPath: "spaced name.txt" },
    ])
  })

  test("resolves a rename with C-escaped (tab) sides", () => {
    expect(parsePorcelainRows('R  "weird\\tname.txt" -> "weird\\trenamed.txt"')).toEqual([
      { x: "R", y: " ", path: "weird\trenamed.txt", origPath: "weird\tname.txt" },
    ])
  })

  test("resolves a rename+modify (RM) row", () => {
    expect(parsePorcelainRows('RM "src/has space.txt" -> "src/has space2.txt"')).toEqual([
      { x: "R", y: "M", path: "src/has space2.txt", origPath: "src/has space.txt" },
    ])
  })

  test("unquotes a non-rename C-quoted untracked path", () => {
    expect(parsePorcelainRows('?? "weird\\tfile.txt"')).toEqual([{ x: "?", y: "?", path: "weird\tfile.txt" }])
  })

  test("unquotes a unicode (octal) untracked path", () => {
    expect(parsePorcelainRows('?? "\\303\\274.txt"')).toEqual([{ x: "?", y: "?", path: "ü.txt" }])
  })
})

const numstat = (path: string, added: number | null, deleted: number | null, origPath?: string): NumstatRow =>
  origPath !== undefined ? { path, origPath, added, deleted } : { path, added, deleted }

describe("parseNumstatRows", () => {
  test("parses a plain modified file", () => {
    expect(parseNumstatRows("3\t2\tsrc/app.ts")).toEqual([numstat("src/app.ts", 3, 2)])
  })

  test("surfaces binary `-` counts as null", () => {
    expect(parseNumstatRows("-\t-\tassets/logo.png")).toEqual([numstat("assets/logo.png", null, null)])
  })

  test("skips blank and malformed lines", () => {
    expect(parseNumstatRows("\n3\t1\ta.ts\nnotatabline\n")).toEqual([numstat("a.ts", 3, 1)])
  })

  test("resolves a same-directory brace-compacted rename", () => {
    expect(parseNumstatRows("0\t0\tsrc/{old.txt => new.txt}")).toEqual([numstat("src/new.txt", 0, 0, "src/old.txt")])
  })

  test("resolves a cross-directory brace rename (leading segment)", () => {
    expect(parseNumstatRows("0\t0\t{dir => other}/x.txt")).toEqual([numstat("other/x.txt", 0, 0, "dir/x.txt")])
  })

  test("resolves a root-level rename with no common segment (no braces)", () => {
    expect(parseNumstatRows("0\t0\troot1.txt => root2.txt")).toEqual([numstat("root2.txt", 0, 0, "root1.txt")])
  })

  test("keeps content-change counts on a renamed-and-edited file", () => {
    expect(parseNumstatRows("8\t1\tsrc/{a.ts => b.ts}")).toEqual([numstat("src/b.ts", 8, 1, "src/a.ts")])
  })

  test("does not mangle a normal path that merely contains a brace", () => {
    expect(parseNumstatRows("1\t0\tsrc/{shared}/util.ts")).toEqual([numstat("src/{shared}/util.ts", 1, 0)])
  })

  test("resolves a quoted (tab) rename with independent quoting per side", () => {
    expect(parseNumstatRows('2\t1\t"weird\\tname.txt" => "weird\\trenamed.txt"')).toEqual([
      numstat("weird\trenamed.txt", 2, 1, "weird\tname.txt"),
    ])
  })

  test("resolves a unicode (octal) rename", () => {
    expect(parseNumstatRows('0\t0\t"\\303\\274.txt" => "\\303\\274v2.txt"')).toEqual([
      numstat("üv2.txt", 0, 0, "ü.txt"),
    ])
  })
})

describe("porcelain ↔ numstat path coherence (the join the bug breaks)", () => {
  test("a spaced rename resolves to the SAME canonical path in both formats", () => {
    // Porcelain quotes the spaced paths; numstat brace-compacts them WITHOUT
    // quoting. Both must unquote/resolve to `src/has space2.txt` so the
    // numstat counts key onto the porcelain `R` row.
    const [p] = parsePorcelainRows('R  "src/has space.txt" -> "src/has space2.txt"')
    const [n] = parseNumstatRows("4\t2\tsrc/{has space.txt => has space2.txt}")
    expect(p?.path).toBe("src/has space2.txt")
    expect(n?.path).toBe("src/has space2.txt")
    expect(p?.path).toBe(n?.path)
  })

  test("a spaced (non-rename) modify resolves identically across formats", () => {
    // Porcelain quotes `"a b.txt"`; numstat leaves `a b.txt` bare.
    const [p] = parsePorcelainRows(' M "a b.txt"')
    const [n] = parseNumstatRows("1\t0\ta b.txt")
    expect(p?.path).toBe("a b.txt")
    expect(n?.path).toBe("a b.txt")
  })

  test("a tab-named modify resolves identically across formats", () => {
    const [p] = parsePorcelainRows(' M "a\\tb.txt"')
    const [n] = parseNumstatRows('1\t0\t"a\\tb.txt"')
    expect(p?.path).toBe("a\tb.txt")
    expect(n?.path).toBe("a\tb.txt")
  })
})
