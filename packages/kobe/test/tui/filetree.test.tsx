/**
 * Stream H — File tree pane unit tests.
 *
 * The full FileTree component is rendered through `@opentui/core`'s
 * native bindings under Bun at runtime; vitest's worker pool runs in
 * Node and cannot load opentui's bun-ffi-structs, so we exercise the
 * pure logic only:
 *
 *   1. `parsePorcelain` — the parser turns `git status --porcelain`
 *      output into structured entries. Edge cases: untracked, renames,
 *      staged-only, worktree-only, deleted, blank lines, malformed
 *      rows.
 *   2. `listFiles` / `statusFiles` — the spawn-glue around git. We
 *      mock `gitWrapper.spawn` so the test never touches a real
 *      git binary or filesystem; assert that the right args are passed
 *      and the returned shape is what the pane consumes.
 *
 * The visual flow (cursor nav, tab switching, theming) is proved by
 * the behavior test (`test/behavior/filetree.test.ts`) which spawns
 * the real kobe binary against a real fixture worktree.
 */

import {
  type FileStatus,
  type GitRunResult,
  type StatusEntry,
  buildTree,
  gitWrapper,
  listFiles,
  parseNumstat,
  parsePorcelain,
  statusFiles,
} from "@/tui/panes/filetree/git"
import { describe, expect, test, vi } from "vitest"

/**
 * Build a fake `GitRunResult` for stubbing `gitWrapper.spawn`. Defaults
 * to a successful call with empty
 * stderr — tests override stdout / status as needed.
 */
function fakeSpawnReturn(stdout: string, status = 0, stderr = ""): GitRunResult {
  return {
    stdout,
    stderr,
    status,
    signal: null,
  }
}

// ---------------------------------------------------------------------
// parsePorcelain — pure parser
// ---------------------------------------------------------------------

describe("parsePorcelain", () => {
  test("returns an empty list for empty input", () => {
    expect(parsePorcelain("")).toEqual([])
    expect(parsePorcelain("\n")).toEqual([])
  })

  test("parses a modified-in-worktree row as M", () => {
    const out = parsePorcelain(" M src/index.ts\n")
    expect(out).toEqual<StatusEntry[]>([{ path: "src/index.ts", status: "M" }])
  })

  test("parses a staged-modify row as M (index status when worktree is space)", () => {
    const out = parsePorcelain("M  src/index.ts\n")
    expect(out).toEqual<StatusEntry[]>([{ path: "src/index.ts", status: "M" }])
  })

  test("parses an added row as A", () => {
    const out = parsePorcelain("A  src/new.ts\n")
    expect(out).toEqual<StatusEntry[]>([{ path: "src/new.ts", status: "A" }])
  })

  test("parses a deleted-in-worktree row as D", () => {
    const out = parsePorcelain(" D src/gone.ts\n")
    expect(out).toEqual<StatusEntry[]>([{ path: "src/gone.ts", status: "D" }])
  })

  test("parses a staged-delete row as D", () => {
    const out = parsePorcelain("D  src/gone.ts\n")
    expect(out).toEqual<StatusEntry[]>([{ path: "src/gone.ts", status: "D" }])
  })

  test("parses an untracked row as ? with the path intact", () => {
    const out = parsePorcelain("?? notes/scratch.md\n")
    expect(out).toEqual<StatusEntry[]>([{ path: "notes/scratch.md", status: "?" }])
  })

  test("parses a rename row to its new path with status R", () => {
    const out = parsePorcelain("R  old/path.ts -> new/path.ts\n")
    expect(out).toEqual<StatusEntry[]>([{ path: "new/path.ts", status: "R" }])
  })

  test("parses multiple mixed rows in source order", () => {
    const raw = ["?? a.txt", " M b.ts", "A  c.ts", " D d.ts", "M  e.ts"].join("\n")
    const out = parsePorcelain(raw)
    expect(out).toEqual<StatusEntry[]>([
      { path: "a.txt", status: "?" },
      { path: "b.ts", status: "M" },
      { path: "c.ts", status: "A" },
      { path: "d.ts", status: "D" },
      { path: "e.ts", status: "M" },
    ])
  })

  test("drops malformed rows silently", () => {
    // Too short, missing status pair, missing space separator.
    const raw = ["", "x", "??", " ", "?Z bad.ts", " M valid.ts"].join("\n")
    const out = parsePorcelain(raw)
    // Only the well-formed " M valid.ts" survives.
    expect(out).toEqual<StatusEntry[]>([{ path: "valid.ts", status: "M" }])
  })

  test("handles paths with spaces in them", () => {
    const out = parsePorcelain(" M src/has spaces.ts\n")
    expect(out).toEqual<StatusEntry[]>([{ path: "src/has spaces.ts", status: "M" }])
  })

  test("collapses copies and unmerged into their porcelain code", () => {
    // C  is a copy; UU would be a both-modified merge conflict.
    const out = parsePorcelain(["C  src/copied.ts", "UU src/conflict.ts"].join("\n"))
    expect(out.map((e) => e.status)).toEqual<FileStatus[]>(["C", "U"])
  })

  test("strips trailing CR before parsing (Windows line endings)", () => {
    const out = parsePorcelain(" M src/file.ts\r\n")
    expect(out).toEqual<StatusEntry[]>([{ path: "src/file.ts", status: "M" }])
  })
})

// ---------------------------------------------------------------------
// listFiles — git ls-files invocation
// ---------------------------------------------------------------------

describe("listFiles", () => {
  test("invokes git ls-files with the documented flags and the cwd", async () => {
    const spy = vi.spyOn(gitWrapper, "spawn").mockResolvedValue(fakeSpawnReturn("a.txt\nb.txt\n"))
    try {
      const files = await listFiles("/tmp/repo")
      expect(files).toEqual(["a.txt", "b.txt"])
      expect(spy).toHaveBeenCalledTimes(1)
      const [args, cwd] = spy.mock.calls[0] ?? []
      expect(args).toEqual(["ls-files", "--cached", "--others", "--exclude-standard", "--full-name"])
      expect(cwd).toBe("/tmp/repo")
    } finally {
      spy.mockRestore()
    }
  })

  test("returns sorted unique paths and drops blank lines", async () => {
    // ls-files can produce both --cached and --others; rare but
    // possible to see the same path twice. Dedup is the contract.
    const spy = vi
      .spyOn(gitWrapper, "spawn")
      .mockResolvedValue(fakeSpawnReturn("zeta.txt\n\nalpha.txt\nzeta.txt\nbeta.txt\n"))
    try {
      const files = await listFiles("/tmp/repo")
      expect(files).toEqual(["alpha.txt", "beta.txt", "zeta.txt"])
    } finally {
      spy.mockRestore()
    }
  })

  test("throws when git exits non-zero", async () => {
    const spy = vi.spyOn(gitWrapper, "spawn").mockResolvedValue(fakeSpawnReturn("", 128, "fatal: not a git repository"))
    try {
      await expect(listFiles("/not-a-repo")).rejects.toThrow(/not a git repository/)
    } finally {
      spy.mockRestore()
    }
  })

  test("returns an empty list when git stdout is empty", async () => {
    const spy = vi.spyOn(gitWrapper, "spawn").mockResolvedValue(fakeSpawnReturn(""))
    try {
      const files = await listFiles("/tmp/repo")
      expect(files).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------
// statusFiles — git status --porcelain invocation
// ---------------------------------------------------------------------

describe("statusFiles", () => {
  test("invokes git status --porcelain then merges in git diff --numstat HEAD", async () => {
    // `statusFiles` makes two git calls now: porcelain for the file
    // list and numstat for +/- counts. We mock both via call-order.
    const spy = vi
      .spyOn(gitWrapper, "spawn")
      .mockResolvedValueOnce(fakeSpawnReturn(" M src/a.ts\n?? b.ts\n"))
      .mockResolvedValueOnce(fakeSpawnReturn("3\t1\tsrc/a.ts\n"))
    try {
      const entries = await statusFiles("/tmp/repo")
      expect(entries).toEqual<StatusEntry[]>([
        { path: "src/a.ts", status: "M", added: 3, deleted: 1 },
        { path: "b.ts", status: "?" },
      ])
      expect(spy).toHaveBeenCalledTimes(2)
      const [args0, cwd0] = spy.mock.calls[0] ?? []
      expect(args0).toEqual(["status", "--porcelain"])
      expect(cwd0).toBe("/tmp/repo")
      const [args1] = spy.mock.calls[1] ?? []
      expect(args1).toEqual(["diff", "--no-color", "--numstat", "HEAD"])
    } finally {
      spy.mockRestore()
    }
  })

  test("falls through gracefully when numstat fails (e.g. no HEAD)", async () => {
    // A fresh repo without HEAD makes `git diff HEAD` exit non-zero;
    // we still want the porcelain rows to come through (without stats).
    const spy = vi
      .spyOn(gitWrapper, "spawn")
      .mockResolvedValueOnce(fakeSpawnReturn(" M src/a.ts\n"))
      .mockResolvedValueOnce(fakeSpawnReturn("", 128, "fatal: bad revision 'HEAD'"))
    try {
      const entries = await statusFiles("/tmp/repo")
      expect(entries).toEqual<StatusEntry[]>([{ path: "src/a.ts", status: "M" }])
    } finally {
      spy.mockRestore()
    }
  })

  test("returns an empty list when nothing is dirty", async () => {
    const spy = vi.spyOn(gitWrapper, "spawn").mockResolvedValue(fakeSpawnReturn(""))
    try {
      const entries = await statusFiles("/tmp/repo")
      expect(entries).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })

  test("throws when porcelain git exits non-zero", async () => {
    const spy = vi.spyOn(gitWrapper, "spawn").mockResolvedValue(fakeSpawnReturn("", 128, "fatal: not a git repository"))
    try {
      await expect(statusFiles("/not-a-repo")).rejects.toThrow(/not a git repository/)
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------
// parseNumstat — pure parser
// ---------------------------------------------------------------------

describe("parseNumstat", () => {
  test("parses standard added/deleted numbers", () => {
    const out = parseNumstat("3\t1\tsrc/a.ts\n0\t12\tsrc/b.ts\n")
    expect(out).toEqual([
      { path: "src/a.ts", added: 3, deleted: 1 },
      { path: "src/b.ts", added: 0, deleted: 12 },
    ])
  })

  test("treats `-` as null (binary files)", () => {
    const out = parseNumstat("-\t-\timg/logo.png\n")
    expect(out).toEqual([{ path: "img/logo.png", added: null, deleted: null }])
  })

  test("strips rename arrow forms to the new path", () => {
    const out = parseNumstat("2\t1\told/path.ts -> new/path.ts\n")
    expect(out).toEqual([{ path: "new/path.ts", added: 2, deleted: 1 }])
  })

  test("drops malformed and empty lines", () => {
    const out = parseNumstat("\nabc\n3\t1\tok.ts\n")
    expect(out).toEqual([{ path: "ok.ts", added: 3, deleted: 1 }])
  })
})

// ---------------------------------------------------------------------
// buildTree — flat paths → nested directories
// ---------------------------------------------------------------------

describe("buildTree", () => {
  test("groups files under their directory parents", () => {
    const root = buildTree(["src/a.ts", "src/b.ts", "README.md"])
    // Top level: `src` (dir) before `README.md` (file).
    expect(root.children.map((c) => `${c.name}${c.isDir ? "/" : ""}`)).toEqual(["src/", "README.md"])
    const src = root.children[0]
    expect(src?.isDir).toBe(true)
    expect(src?.children.map((c) => c.name)).toEqual(["a.ts", "b.ts"])
  })

  test("sorts directories before files at every level, then alphabetical", () => {
    const root = buildTree(["z.ts", "a/x.ts", "b.ts", "a/sub/y.ts"])
    const top = root.children.map((c) => `${c.name}${c.isDir ? "/" : ""}`)
    expect(top).toEqual(["a/", "b.ts", "z.ts"])
    const aDir = root.children.find((c) => c.name === "a")
    const aChildren = aDir?.children.map((c) => `${c.name}${c.isDir ? "/" : ""}`)
    expect(aChildren).toEqual(["sub/", "x.ts"])
  })

  test("dedupes overlapping segments — multiple files sharing a parent dir", () => {
    const root = buildTree(["pkg/a.ts", "pkg/a.ts", "pkg/b.ts"])
    const pkg = root.children[0]
    expect(pkg?.name).toBe("pkg")
    expect(pkg?.children.map((c) => c.name)).toEqual(["a.ts", "b.ts"])
  })

  test("returns an empty root when given no paths", () => {
    const root = buildTree([])
    expect(root.children).toEqual([])
  })
})
