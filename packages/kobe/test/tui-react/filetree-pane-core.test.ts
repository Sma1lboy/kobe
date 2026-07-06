/**
 * pane-core — the framework-free file-tree logic extracted for the React
 * port (issue #15, G3). Both runtimes drive their cursor / expansion /
 * stat-column behavior through these functions, so this suite is the single
 * behavioral pin for hierarchy navigation (`h`/`l` semantics), the
 * Changes-tab stat alignment math, git-error summarization, and the
 * fs-watch event filter. A regression here misbehaves identically in the
 * Solid pane and the React pane — which is exactly the point of the
 * extraction.
 */

import { describe, expect, test } from "vitest"
import { TAB_ORDER, tabLabelKey } from "../../src/tui/panes/filetree/keys-core"
import {
  collapseOrParentAction,
  computePathBudget,
  computeStatWidths,
  expandOrDescendAction,
  followScrollTop,
  statCell,
  statusToken,
  summarizeGitError,
  toggleDir,
  watchEventRelevant,
  watchWorktree,
} from "../../src/tui/panes/filetree/pane-core"
import type { Row } from "../../src/tui/panes/filetree/rows"

// A small All-tab row list:
//   0  dir  src/        (expanded, has children)
//   1  file src/a.ts    (depth 1)
//   2  dir  src/lib/    (closed, has children, depth 1)
//   3  file top.ts      (depth 0)
const treeRows: Row[] = [
  { kind: "dir", path: "src", name: "src", depth: 0, expanded: true, hasChildren: true },
  { kind: "file", path: "src/a.ts", name: "a.ts", depth: 1 },
  { kind: "dir", path: "src/lib", name: "lib", depth: 1, expanded: false, hasChildren: true },
  { kind: "file", path: "top.ts", name: "top.ts", depth: 0 },
]

const statusRowsFixture: Row[] = [
  { kind: "status", path: "src/index.ts", status: "M", added: 12, deleted: 202 },
  { kind: "status", path: "new.txt", status: "?", added: 3, deleted: 0 },
  { kind: "status", path: "bin.dat", status: "A", added: null, deleted: null },
]

describe("statusToken", () => {
  test("maps every status to its theme token", () => {
    expect(statusToken("M")).toBe("warning")
    expect(statusToken("A")).toBe("success")
    expect(statusToken("D")).toBe("error")
    expect(statusToken("?")).toBe("textMuted")
    for (const s of ["R", "C", "U", "T"] as const) expect(statusToken(s)).toBe("info")
  })
})

describe("summarizeGitError", () => {
  const t = (key: string) => `<${key}>`
  test("maps the common failure classes to i18n keys", () => {
    expect(summarizeGitError("fatal: not a git repository", t)).toBe("<files.error.notGitRepo>")
    expect(summarizeGitError("ENOENT: no such file", t)).toBe("<files.error.pathMissing>")
    expect(summarizeGitError("EACCES permission denied", t)).toBe("<files.error.permissionDenied>")
    expect(summarizeGitError("bash: git: not found", t)).toBe("<files.error.gitNotInstalled>")
  })
  test("strips the git-args boilerplate from unknown git errors", () => {
    expect(summarizeGitError("git ls-files --cached (cwd=/x) exited with code 128: something odd", t)).toBe(
      "something odd",
    )
  })
  test("falls back to the raw text, then the generic key", () => {
    expect(summarizeGitError("  weird failure  ", t)).toBe("weird failure")
    expect(summarizeGitError("   ", t)).toBe("<files.error.gitFailed>")
  })
})

describe("stat columns", () => {
  test("widths pad to the widest sibling, sign included", () => {
    // widest added `+12` → 3; widest deleted `-202` → 4.
    expect(computeStatWidths(statusRowsFixture)).toEqual({ added: 3, deleted: 4 })
  })
  test("non-status rows and null counts contribute nothing", () => {
    expect(computeStatWidths(treeRows)).toEqual({ added: 0, deleted: 0 })
    expect(computeStatWidths([statusRowsFixture[2] as Row])).toEqual({ added: 0, deleted: 0 })
  })
  test("path budget subtracts chrome + stat columns with a floor of 8", () => {
    expect(computePathBudget(38, { added: 3, deleted: 4 })).toBe(38 - 6 - 9)
    expect(computePathBudget(38, { added: 0, deleted: 0 })).toBe(32)
    expect(computePathBudget(10, { added: 3, deleted: 4 })).toBe(8)
  })
  test("statCell right-aligns counts and blanks missing ones", () => {
    expect(statCell(12, 3, "+")).toBe("+12")
    expect(statCell(1, 3, "+")).toBe(" +1")
    expect(statCell(null, 4, "-")).toBe("    ")
    expect(statCell(undefined, 2, "-")).toBe("  ")
  })
})

describe("toggleDir", () => {
  test("adds and removes immutably", () => {
    const start: ReadonlySet<string> = new Set(["a"])
    const opened = toggleDir(start, "b")
    expect([...opened].sort()).toEqual(["a", "b"])
    const closed = toggleDir(opened, "a")
    expect([...closed]).toEqual(["b"])
    expect([...start]).toEqual(["a"]) // untouched
  })
})

describe("expandOrDescendAction (`l`)", () => {
  test("closed dir with children → expand", () => {
    expect(expandOrDescendAction(treeRows, 2)).toEqual({ type: "expand", path: "src/lib" })
  })
  test("open dir → step to the next row", () => {
    expect(expandOrDescendAction(treeRows, 0)).toEqual({ type: "cursor", index: 1 })
  })
  test("open dir at the end of the list → no-op", () => {
    const rows: Row[] = [{ kind: "dir", path: "src", name: "src", depth: 0, expanded: true, hasChildren: true }]
    expect(expandOrDescendAction(rows, 0)).toBeNull()
  })
  test("files and out-of-range cursors → no-op", () => {
    expect(expandOrDescendAction(treeRows, 1)).toBeNull()
    expect(expandOrDescendAction(treeRows, 99)).toBeNull()
  })
})

describe("collapseOrParentAction (`h`)", () => {
  test("open dir → collapse it", () => {
    expect(collapseOrParentAction(treeRows, 0)).toEqual({ type: "collapse", path: "src" })
  })
  test("nested row → jump to its parent dir", () => {
    expect(collapseOrParentAction(treeRows, 1)).toEqual({ type: "cursor", index: 0 })
    expect(collapseOrParentAction(treeRows, 2)).toEqual({ type: "cursor", index: 0 })
  })
  test("top-level file / status rows / empty → no-op", () => {
    expect(collapseOrParentAction(treeRows, 3)).toBeNull()
    expect(collapseOrParentAction(statusRowsFixture, 0)).toBeNull()
    expect(collapseOrParentAction([], 0)).toBeNull()
  })
})

describe("followScrollTop", () => {
  test("cursor above the window scrolls it to the cursor", () => {
    expect(followScrollTop(10, 5, 3)).toBe(3)
  })
  test("cursor below the window scrolls it just inside", () => {
    expect(followScrollTop(0, 5, 9)).toBe(5)
  })
  test("cursor inside the window / degenerate viewport → no scroll", () => {
    expect(followScrollTop(2, 5, 4)).toBeNull()
    expect(followScrollTop(0, 0, 3)).toBeNull()
  })
})

describe("fs watch", () => {
  test("filters .git and node_modules churn", () => {
    expect(watchEventRelevant(".git")).toBe(false)
    expect(watchEventRelevant(".git/HEAD")).toBe(false)
    expect(watchEventRelevant("node_modules/react/index.js")).toBe(false)
    expect(watchEventRelevant("src/index.ts")).toBe(true)
    expect(watchEventRelevant(".gitignore")).toBe(true)
  })
  test("watchWorktree on an unwatchable path degrades to a no-op disposer", () => {
    const dispose = watchWorktree("/nonexistent/kobe-filetree-test", () => {})
    expect(() => dispose()).not.toThrow()
  })
})

describe("keys-core tab vocabulary", () => {
  test("tab order and label keys stay in sync", () => {
    expect(TAB_ORDER).toEqual(["all", "changes"])
    expect(TAB_ORDER.map(tabLabelKey)).toEqual(["files.tabs.all", "files.tabs.changes"])
  })
})
