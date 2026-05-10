/**
 * Stream I — Preview pane unit tests.
 *
 * Strategy mirrors `test/tui/sidebar.test.tsx`:
 *   - Pure logic lives in `state.ts` and `diff.ts`. We test those
 *     directly, leaf-import to avoid pulling `@opentui/core` into the
 *     vitest worker (Node) — opentui's native bindings need Bun.
 *   - The Solid component (`Preview.tsx`) is exercised end-to-end by
 *     the behavior test (`test/behavior/preview.test.ts`) which spawns
 *     the real binary in a PTY.
 *
 * What this file covers:
 *   - `state.ts`: open/close idempotency, active index migration on
 *     close, mode-per-tab, scroll persistence per tab, label derivation.
 *   - `diff.ts`: `splitLines` parses both LF and CRLF; `readFile` and
 *     `readDiff` against a tiny on-disk git repo.
 *
 * We deliberately do NOT test `Preview.tsx` here. Its responsibility is
 * to glue these pure modules to opentui — the behavior test proves that
 * end-to-end and unit-testing the JSX would require a renderer harness
 * we don't have.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isPathChanged, readDiff, readFile, splitLines } from "@/tui/panes/preview/diff"
import {
  EMPTY_STATE,
  activeTab,
  closeTab,
  findTabIndex,
  moveActive,
  openTab,
  setActiveMode,
  setActiveScroll,
  tabLabel,
} from "@/tui/panes/preview/state"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

/* --------------------------------------------------------------------- */
/*  state.ts — pure tab list semantics                                    */
/* --------------------------------------------------------------------- */

describe("state.openTab", () => {
  test("opens a tab into an empty state and activates it", () => {
    const s = openTab(EMPTY_STATE, "src/index.ts")
    expect(s.tabs).toHaveLength(1)
    expect(s.activeIndex).toBe(0)
    expect(activeTab(s)?.path).toBe("src/index.ts")
    expect(activeTab(s)?.mode).toBe("file")
  })

  test("re-opening an existing tab focuses it without duplicating", () => {
    const s1 = openTab(EMPTY_STATE, "a.ts")
    const s2 = openTab(s1, "b.ts")
    const s3 = openTab(s2, "a.ts")
    expect(s3.tabs).toHaveLength(2)
    expect(activeTab(s3)?.path).toBe("a.ts")
  })

  test("re-opening the already-active tab is a no-op (returns the same ref)", () => {
    const s1 = openTab(EMPTY_STATE, "a.ts")
    const s2 = openTab(s1, "a.ts")
    expect(s2).toBe(s1)
  })

  test("preserves prior tabs in their original order", () => {
    let s = openTab(EMPTY_STATE, "a.ts")
    s = openTab(s, "b.ts")
    s = openTab(s, "c.ts")
    expect(s.tabs.map((t) => t.path)).toEqual(["a.ts", "b.ts", "c.ts"])
    expect(s.activeIndex).toBe(2)
  })

  test("respects an explicit default mode for fresh tabs", () => {
    const s = openTab(EMPTY_STATE, "a.ts", "diff")
    expect(activeTab(s)?.mode).toBe("diff")
  })
})

describe("state.closeTab", () => {
  function threeTabs() {
    let s = openTab(EMPTY_STATE, "a.ts")
    s = openTab(s, "b.ts")
    s = openTab(s, "c.ts")
    return s
  }

  test("removes the tab and returns to EMPTY_STATE when last", () => {
    const s = openTab(EMPTY_STATE, "a.ts")
    expect(closeTab(s, "a.ts")).toEqual(EMPTY_STATE)
  })

  test("closing the active tab steps right when possible", () => {
    let s = threeTabs()
    s = moveActive(s, -2) // active = 0 (a.ts)
    expect(activeTab(s)?.path).toBe("a.ts")
    s = closeTab(s, "a.ts")
    expect(s.tabs.map((t) => t.path)).toEqual(["b.ts", "c.ts"])
    // The "right" tab after deletion lives at the same index.
    expect(activeTab(s)?.path).toBe("b.ts")
  })

  test("closing the rightmost active tab steps left", () => {
    const s = threeTabs() // active = 2 (c.ts)
    const next = closeTab(s, "c.ts")
    expect(next.tabs.map((t) => t.path)).toEqual(["a.ts", "b.ts"])
    expect(activeTab(next)?.path).toBe("b.ts")
  })

  test("closing a tab to the left of active keeps the same focused tab", () => {
    const s = threeTabs() // active = 2 (c.ts)
    const next = closeTab(s, "a.ts")
    expect(next.tabs.map((t) => t.path)).toEqual(["b.ts", "c.ts"])
    expect(activeTab(next)?.path).toBe("c.ts")
  })

  test("closing a path that doesn't exist is a no-op", () => {
    const s = threeTabs()
    expect(closeTab(s, "missing.ts")).toBe(s)
  })
})

describe("state.moveActive", () => {
  test("wraps modulo on positive overflow", () => {
    let s = openTab(EMPTY_STATE, "a.ts")
    s = openTab(s, "b.ts") // active = 1
    s = moveActive(s, 1) // wraps to 0
    expect(activeTab(s)?.path).toBe("a.ts")
  })

  test("wraps modulo on negative underflow", () => {
    let s = openTab(EMPTY_STATE, "a.ts") // active = 0
    s = openTab(s, "b.ts")
    s = moveActive(s, -3) // wraps -1 mod 2 = 1, then -2 mod 2 = 0
    expect(activeTab(s)?.path).toBe("a.ts")
  })

  test("no-op on empty state", () => {
    expect(moveActive(EMPTY_STATE, 1)).toBe(EMPTY_STATE)
  })
})

describe("state.setActiveMode", () => {
  test("updates only the active tab's mode", () => {
    let s = openTab(EMPTY_STATE, "a.ts")
    s = openTab(s, "b.ts") // active = 1
    s = setActiveMode(s, "diff")
    expect(s.tabs[0]?.mode).toBe("file")
    expect(s.tabs[1]?.mode).toBe("diff")
  })

  test("returns same ref when already at requested mode", () => {
    const s = openTab(EMPTY_STATE, "a.ts", "file")
    expect(setActiveMode(s, "file")).toBe(s)
  })

  test("no-op on empty state", () => {
    expect(setActiveMode(EMPTY_STATE, "diff")).toBe(EMPTY_STATE)
  })
})

describe("state.setActiveScroll", () => {
  test("persists scrollTop on the active tab only", () => {
    let s = openTab(EMPTY_STATE, "a.ts")
    s = openTab(s, "b.ts") // active = 1
    s = setActiveScroll(s, 42)
    expect(s.tabs[0]?.scrollTop).toBe(0)
    expect(s.tabs[1]?.scrollTop).toBe(42)
  })

  test("no-op when already at requested scroll", () => {
    const s = openTab(EMPTY_STATE, "a.ts")
    expect(setActiveScroll(s, 0)).toBe(s)
  })
})

describe("state.findTabIndex / tabLabel", () => {
  test("findTabIndex returns -1 when missing", () => {
    expect(findTabIndex(EMPTY_STATE, "x")).toBe(-1)
  })

  test("tabLabel returns the basename", () => {
    expect(tabLabel({ path: "src/preview/Preview.tsx", mode: "file", scrollTop: 0 })).toBe("Preview.tsx")
    expect(tabLabel({ path: "Dockerfile", mode: "file", scrollTop: 0 })).toBe("Dockerfile")
  })
})

/* --------------------------------------------------------------------- */
/*  diff.ts — line splitting + on-disk git diff                           */
/* --------------------------------------------------------------------- */

describe("splitLines", () => {
  test("returns empty array for empty input", () => {
    expect(splitLines("")).toEqual([])
  })

  test("splits on both LF and CRLF", () => {
    expect(splitLines("a\nb\r\nc")).toEqual(["a", "b", "c"])
  })

  test("preserves trailing empty line so renderer shows it", () => {
    expect(splitLines("a\n")).toEqual(["a", ""])
  })
})

/**
 * On-disk fixture: a tiny git repo with one tracked file. Each test
 * gets its own tmpdir so concurrent runs don't collide. Setup is
 * synchronous (small repo, tens of ms).
 */
let repoDir: string

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-preview-unit-"))
  // git init + commit a known file. Use --quiet to keep test logs clean.
  spawnSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: repoDir })
  spawnSync("git", ["config", "user.email", "harness@kobe.test"], { cwd: repoDir })
  spawnSync("git", ["config", "user.name", "kobe harness"], { cwd: repoDir })
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: repoDir })
  fs.writeFileSync(path.join(repoDir, "hello.txt"), "alpha\nbeta\ngamma\n")
  spawnSync("git", ["add", "hello.txt"], { cwd: repoDir })
  spawnSync("git", ["commit", "--quiet", "-m", "init"], { cwd: repoDir })
})

afterEach(() => {
  if (repoDir && fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true })
})

describe("readFile", () => {
  test("returns file content when present", async () => {
    const r = await readFile(repoDir, "hello.txt")
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toBe("alpha\nbeta\ngamma\n")
      expect(r.truncated).toBe(false)
    }
  })

  test("returns error for missing file", async () => {
    const r = await readFile(repoDir, "no-such-file.txt")
    expect(r.ok).toBe(false)
  })

  test("rejects path traversal", async () => {
    const r = await readFile(repoDir, "../etc/passwd")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("escapes")
  })

  test("rejects empty path", async () => {
    const r = await readFile(repoDir, "")
    expect(r.ok).toBe(false)
  })
})

describe("readDiff", () => {
  test("returns empty text when file matches base exactly", async () => {
    const r = await readDiff(repoDir, "main", "hello.txt")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.text).toBe("")
  })

  test("returns a unified diff when working copy differs", async () => {
    fs.writeFileSync(path.join(repoDir, "hello.txt"), "alpha\nbeta\ndelta\n")
    const r = await readDiff(repoDir, "main", "hello.txt")
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Sanity: the unified diff has a hunk header and the changed lines.
      expect(r.text).toContain("@@")
      expect(r.text).toContain("-gamma")
      expect(r.text).toContain("+delta")
    }
  })

  test("returns an error for an unknown base ref", async () => {
    const r = await readDiff(repoDir, "no-such-branch", "hello.txt")
    expect(r.ok).toBe(false)
  })
})

describe("isPathChanged", () => {
  test("false when working copy is clean", async () => {
    expect(await isPathChanged(repoDir, "hello.txt")).toBe(false)
  })

  test("true when the file has been modified", async () => {
    fs.writeFileSync(path.join(repoDir, "hello.txt"), "alpha\nbeta\ndelta\n")
    expect(await isPathChanged(repoDir, "hello.txt")).toBe(true)
  })
})
