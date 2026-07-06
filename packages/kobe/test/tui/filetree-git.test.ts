/**
 * Unit tests for the file tree's git wrappers (`filetree/git.ts`).
 *
 * Focus: `parseNumstat` rename handling. `git diff --numstat` renders a
 * rename with ` => ` (NOT porcelain's ` -> `) and brace-compacts the
 * unchanged path segments. The Changes tab merges these counts onto the
 * porcelain `R` row by PATH, so the parser must resolve the numstat field
 * to the same canonical post-rename path porcelain reports — otherwise a
 * renamed file silently shows no +/- line counts.
 *
 * Also covers `parsePorcelain` (headline collapsing), `buildTree` (dir/file
 * grouping), and the `listFiles`/`statusFiles` git-invoking wrappers, whose
 * only seam is `runWorktreeGit`/`readWorktreeFile` from `worktree/content.ts` —
 * mocked below (spreading the real module so any export the code path touches
 * that we didn't stub still resolves, per the mocking gotcha).
 */

import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("../../src/worktree/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/worktree/content")>()
  return {
    ...actual,
    runWorktreeGit: vi.fn(),
    readWorktreeFile: vi.fn(),
  }
})

import { buildTree, listFiles, parseNumstat, parsePorcelain, statusFiles } from "../../src/tui/panes/filetree/git"
import { readWorktreeFile, runWorktreeGit } from "../../src/worktree/content"

const runGit = vi.mocked(runWorktreeGit)
const readFile = vi.mocked(readWorktreeFile)

function ok(stdout: string): { stdout: string; stderr: string; status: number } {
  return { stdout, stderr: "", status: 0 }
}
function fail(stderr = "boom"): { stdout: string; stderr: string; status: number } {
  return { stdout: "", stderr, status: 1 }
}

beforeEach(() => {
  runGit.mockReset()
  readFile.mockReset()
})

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

describe("parsePorcelain", () => {
  test("collapses to worktree status when present, else index status", () => {
    expect(parsePorcelain(" M a.ts\nM  b.ts\n")).toEqual([
      { path: "a.ts", status: "M" },
      { path: "b.ts", status: "M" },
    ])
  })

  test("reports untracked rows as ?", () => {
    expect(parsePorcelain("?? new.txt\n")).toEqual([{ path: "new.txt", status: "?" }])
  })

  test("keeps only the new path for a rename row", () => {
    expect(parsePorcelain("R  old.txt -> new.txt\n")).toEqual([{ path: "new.txt", status: "R" }])
  })

  test("skips a row whose collapsed status is unrecognized", () => {
    // "!" is git's ignored-file marker in porcelain v2 extensions; v1 never
    // emits it, so this exercises the "skip rather than display garbage" branch.
    expect(parsePorcelain("!! ignored.txt\n")).toEqual([])
  })

  test("skips a trailing-slash directory row defensively", () => {
    expect(parsePorcelain("?? dir/\n")).toEqual([])
  })

  test("empty input yields no entries", () => {
    expect(parsePorcelain("")).toEqual([])
  })
})

describe("buildTree", () => {
  test("groups files under their parent directories, dirs before files, alphabetical", () => {
    const tree = buildTree(["src/b.ts", "src/a.ts", "README.md", "src/nested/c.ts"])
    expect(tree.children.map((c) => c.name)).toEqual(["src", "README.md"])
    const src = tree.children[0]!
    expect(src.isDir).toBe(true)
    expect(src.children.map((c) => c.name)).toEqual(["nested", "a.ts", "b.ts"])
    const nested = src.children[0]!
    expect(nested.children.map((c) => c.name)).toEqual(["c.ts"])
    expect(nested.children[0]!.path).toBe("src/nested/c.ts")
  })

  test("ignores empty-string paths", () => {
    expect(buildTree(["", "a.ts"]).children.map((c) => c.name)).toEqual(["a.ts"])
  })

  test("empty input yields an empty root", () => {
    const tree = buildTree([])
    expect(tree.isDir).toBe(true)
    expect(tree.children).toEqual([])
  })
})

describe("listFiles", () => {
  test("de-dupes and sorts the ls-files output", () => {
    runGit.mockResolvedValue(ok("b.ts\na.ts\na.ts\n"))
    return listFiles("/repo").then((files) => {
      expect(files).toEqual(["a.ts", "b.ts"])
      expect(runGit).toHaveBeenCalledWith(
        "/repo",
        ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name"],
        { signal: undefined },
      )
    })
  })

  test("throws with a descriptive message on non-zero exit", async () => {
    runGit.mockResolvedValue(fail("not a git repo"))
    await expect(listFiles("/repo")).rejects.toThrow(/not a git repo/)
  })

  test("strips trailing CR and drops blank lines", async () => {
    runGit.mockResolvedValue(ok("a.ts\r\n\nb.ts\r\n"))
    expect(await listFiles("/repo")).toEqual(["a.ts", "b.ts"])
  })
})

describe("statusFiles", () => {
  test("merges numstat counts onto porcelain rows by path", async () => {
    runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "status") return ok(" M a.ts\n")
      if (args[0] === "diff") return ok("3\t1\ta.ts\n")
      throw new Error(`unexpected args ${args.join(" ")}`)
    })
    const rows = await statusFiles("/repo")
    expect(rows).toEqual([{ path: "a.ts", status: "M", added: 3, deleted: 1 }])
  })

  test("falls back to the cached diff when `diff HEAD` fails (unborn branch)", async () => {
    runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "status") return ok("A  new.ts\n")
      if (args.includes("HEAD")) return fail("no HEAD")
      if (args.includes("--cached")) return ok("5\t0\tnew.ts\n")
      throw new Error(`unexpected args ${args.join(" ")}`)
    })
    const rows = await statusFiles("/repo")
    expect(rows).toEqual([{ path: "new.ts", status: "A", added: 5, deleted: 0 }])
  })

  test("leaves stats empty when both diff attempts fail", async () => {
    runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "status") return ok("A  new.ts\n")
      return fail("no HEAD, no index")
    })
    const rows = await statusFiles("/repo")
    expect(rows).toEqual([{ path: "new.ts", status: "A" }])
  })

  test("counts on-disk lines for untracked files missing from numstat", async () => {
    runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "status") return ok("?? untracked.txt\n")
      if (args[0] === "diff") return ok("")
      throw new Error(`unexpected args ${args.join(" ")}`)
    })
    readFile.mockResolvedValue("line1\nline2\nline3")
    const rows = await statusFiles("/repo")
    expect(rows).toEqual([{ path: "untracked.txt", status: "?", added: 3, deleted: 0 }])
  })

  test("leaves an untracked file's counts blank when the on-disk read fails", async () => {
    runGit.mockImplementation(async (_cwd, args) => {
      if (args[0] === "status") return ok("?? gone.txt\n")
      if (args[0] === "diff") return ok("")
      throw new Error(`unexpected args ${args.join(" ")}`)
    })
    readFile.mockResolvedValue(null)
    const rows = await statusFiles("/repo")
    expect(rows).toEqual([{ path: "gone.txt", status: "?" }])
  })
})
