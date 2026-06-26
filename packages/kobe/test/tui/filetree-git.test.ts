/**
 * Unit tests for the file tree's pure git parsers (`filetree/git.ts`).
 *
 * Focus: `parseNumstat` rename handling. `git diff --numstat` renders a
 * rename with ` => ` (NOT porcelain's ` -> `) and brace-compacts the
 * unchanged path segments. The Changes tab merges these counts onto the
 * porcelain `R` row by PATH, so the parser must resolve the numstat field
 * to the same canonical post-rename path porcelain reports — otherwise a
 * renamed file silently shows no +/- line counts.
 */

import { describe, expect, test } from "vitest"
import { parseNumstat } from "../../src/tui/panes/filetree/git"

describe("parseNumstat", () => {
  test("parses a plain modified file", () => {
    expect(parseNumstat("3\t2\tsrc/app.ts")).toEqual([{ path: "src/app.ts", added: 3, deleted: 2 }])
  })

  test("surfaces binary `-` counts as null", () => {
    expect(parseNumstat("-\t-\tassets/logo.png")).toEqual([{ path: "assets/logo.png", added: null, deleted: null }])
  })

  test("ignores blank and malformed lines", () => {
    expect(parseNumstat("\n3\t1\ta.ts\nnotatabline\n")).toEqual([{ path: "a.ts", added: 3, deleted: 1 }])
  })

  // ── Rename forms (the bug this file pins) ────────────────────────────────
  // git outputs ` => ` with brace-compaction; the canonical NEW path must
  // match what `git status --porcelain` reports as the `R` row's path.

  test("resolves a same-directory rename to the new path", () => {
    // git: `0\t0\tsrc/{old.txt => new.txt}`  (porcelain row: `src/new.txt`)
    expect(parseNumstat("0\t0\tsrc/{old.txt => new.txt}")).toEqual([{ path: "src/new.txt", added: 0, deleted: 0 }])
  })

  test("resolves a cross-directory rename (brace on the leading segment)", () => {
    // git: `0\t0\t{dir => other}/x.txt`  (porcelain row: `other/x.txt`)
    expect(parseNumstat("0\t0\t{dir => other}/x.txt")).toEqual([{ path: "other/x.txt", added: 0, deleted: 0 }])
  })

  test("resolves a root-level rename with no common segment (no braces)", () => {
    // git: `0\t0\troot1.txt => root2.txt`  (porcelain row: `root2.txt`)
    expect(parseNumstat("0\t0\troot1.txt => root2.txt")).toEqual([{ path: "root2.txt", added: 0, deleted: 0 }])
  })

  test("keeps content-change counts on a renamed-and-edited file", () => {
    expect(parseNumstat("8\t1\tsrc/{a.ts => b.ts}")).toEqual([{ path: "src/b.ts", added: 8, deleted: 1 }])
  })

  test("does not mangle a normal path that merely contains a brace", () => {
    // No ` => ` inside the braces → not a rename → returned verbatim.
    expect(parseNumstat("1\t0\tsrc/{shared}/util.ts")).toEqual([{ path: "src/{shared}/util.ts", added: 1, deleted: 0 }])
  })
})
