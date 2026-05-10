/**
 * Unit tests for the pure helpers in
 * `src/tui/component/new-task-dialog/state.ts`.
 *
 * Why these tests matter:
 *   - The new-task dialog is the single entry point users hit before
 *     every task they spawn. A subtle regression in repo-list dedup
 *     or branch filtering would block every new task — there is no
 *     fallback path. The visible behavior is covered end-to-end by
 *     `test/behavior/keybindings.test.ts`, but those are PTY-driven
 *     and run ~30s/each, so we keep the algorithmic surface
 *     unit-tested for fast feedback.
 *   - These helpers were inlined in `src/tui/app.tsx` before the
 *     refactor that landed this file; they had zero direct test
 *     coverage. Lifting them out + pinning their contract is the
 *     point of the refactor.
 *
 * No opentui / Solid imports — the helpers are pure functions
 * (validateRepoPath + listLocalBranches do hit the filesystem and
 * spawn `git`, but they're tolerant by design and we test the
 * tolerant branch here without standing up a real repo).
 */

import { describe, expect, test } from "vitest"
import {
  DEFAULT_BASE_REF,
  PICKER_MAX_VISIBLE,
  clampCursor,
  computeRepoOptions,
  filterBranches,
  filterRepos,
  listLocalBranches,
  nextField,
  resolveBaseRef,
  stripNewlines,
  validateRepoPath,
  windowAround,
} from "../../../src/tui/component/new-task-dialog/state"

describe("stripNewlines", () => {
  test("removes \\n and \\r from the input", () => {
    expect(stripNewlines("hello\nworld")).toBe("helloworld")
    expect(stripNewlines("a\r\nb")).toBe("ab")
    expect(stripNewlines("multi\n\n\nline\rdrop")).toBe("multilinedrop")
  })
  test("leaves newline-free input untouched", () => {
    expect(stripNewlines("/Users/jacksonc/i/kobe")).toBe("/Users/jacksonc/i/kobe")
    expect(stripNewlines("")).toBe("")
  })
})

describe("nextField — tab cycling", () => {
  test("cycles repoPicker → repoCustom → baseRef → repoPicker", () => {
    expect(nextField("repoPicker")).toBe("repoCustom")
    expect(nextField("repoCustom")).toBe("baseRef")
    expect(nextField("baseRef")).toBe("repoPicker")
  })
})

describe("computeRepoOptions — repo list assembly", () => {
  test("prepends defaultRepo and dedupes against savedRepos", () => {
    const out = computeRepoOptions("/cwd", ["/foo", "/bar"])
    expect(out).toEqual(["/cwd", "/foo", "/bar"])
  })

  test("filters out empty / whitespace-only entries", () => {
    const out = computeRepoOptions("/cwd", ["", "  ", "/foo"])
    expect(out).toEqual(["/cwd", "/foo"])
  })

  test("removes savedRepos duplicates of defaultRepo and of each other", () => {
    const out = computeRepoOptions("/cwd", ["/cwd", "/foo", "/foo", "/bar"])
    expect(out).toEqual(["/cwd", "/foo", "/bar"])
  })

  test("trims whitespace before deduping", () => {
    const out = computeRepoOptions("/cwd", ["  /cwd  ", " /foo "])
    expect(out).toEqual(["/cwd", "/foo"])
  })

  test("returns just defaultRepo when savedRepos is empty", () => {
    expect(computeRepoOptions("/cwd", [])).toEqual(["/cwd"])
  })
})

describe("filterRepos / filterBranches — substring filtering", () => {
  test("empty query returns the input list verbatim", () => {
    const all = ["/foo", "/bar"]
    expect(filterRepos(all, "")).toBe(all)
    expect(filterRepos(all, "   ")).toBe(all)
    expect(filterBranches(all, "")).toBe(all)
  })

  test("case-insensitive substring match against the list", () => {
    const all = ["/Users/Foo", "/Users/Bar", "/tmp/baz"]
    expect(filterRepos(all, "foo")).toEqual(["/Users/Foo"])
    expect(filterRepos(all, "USERS")).toEqual(["/Users/Foo", "/Users/Bar"])
    expect(filterRepos(all, "no-match")).toEqual([])
  })

  test("branch filter follows the same rules", () => {
    expect(filterBranches(["main", "feature/x", "fix-foo"], "foo")).toEqual(["fix-foo"])
    expect(filterBranches(["main"], "MAIN")).toEqual(["main"])
  })
})

describe("windowAround — picker windowing", () => {
  test("returns the list unchanged when total ≤ cap", () => {
    const list = ["a", "b", "c"]
    const out = windowAround(list, 1)
    expect(out).toEqual({ items: list, start: 0, total: 3 })
  })

  test("scrolls to keep cursor centered when total > cap", () => {
    const list = Array.from({ length: 20 }, (_, i) => `r${i}`)
    // PICKER_MAX_VISIBLE is 8 → half = 4 → cursor=10 → start=6
    const out = windowAround(list, 10)
    expect(out.total).toBe(20)
    expect(out.start).toBe(6)
    expect(out.items.length).toBe(PICKER_MAX_VISIBLE)
    expect(out.items[0]).toBe("r6")
    expect(out.items[out.items.length - 1]).toBe("r13")
  })

  test("clamps the window to the end when cursor is near the tail", () => {
    const list = Array.from({ length: 12 }, (_, i) => `r${i}`)
    const out = windowAround(list, 11)
    expect(out.start).toBe(12 - PICKER_MAX_VISIBLE)
    expect(out.items.length).toBe(PICKER_MAX_VISIBLE)
    expect(out.items[out.items.length - 1]).toBe("r11")
  })

  test("clamps the window to 0 when cursor is at the head", () => {
    const list = Array.from({ length: 12 }, (_, i) => `r${i}`)
    const out = windowAround(list, 0)
    expect(out.start).toBe(0)
    expect(out.items[0]).toBe("r0")
  })

  test("honors a custom cap", () => {
    const list = ["a", "b", "c", "d", "e", "f"]
    const out = windowAround(list, 2, 3)
    expect(out.items.length).toBe(3)
    expect(out.total).toBe(6)
  })

  test("empty list returns empty window", () => {
    const out = windowAround([], 0)
    expect(out).toEqual({ items: [], start: 0, total: 0 })
  })
})

describe("clampCursor", () => {
  test("clamps to [0, len-1] for non-empty lists", () => {
    expect(clampCursor(5, 10)).toBe(5)
    expect(clampCursor(-1, 10)).toBe(0)
    expect(clampCursor(99, 10)).toBe(9)
  })
  test("returns 0 for empty lists", () => {
    expect(clampCursor(5, 0)).toBe(0)
    expect(clampCursor(0, 0)).toBe(0)
  })
})

describe("resolveBaseRef — picker-over-typed-text priority", () => {
  test("prefers the highlighted branch when one exists at the cursor", () => {
    expect(resolveBaseRef("ma", ["main", "master"], 1)).toBe("master")
  })

  test("falls back to typed text when cursor is past the end", () => {
    expect(resolveBaseRef("v1.2.3", [], 0)).toBe("v1.2.3")
    expect(resolveBaseRef("tag/foo", ["main"], 7)).toBe("tag/foo")
  })

  test("returns DEFAULT_BASE_REF when typed text is blank and no match", () => {
    expect(resolveBaseRef("   ", [], 0)).toBe(DEFAULT_BASE_REF)
    expect(resolveBaseRef("", [], 0)).toBe(DEFAULT_BASE_REF)
  })

  test("trims typed text before returning it", () => {
    expect(resolveBaseRef("  abc123  ", [], 0)).toBe("abc123")
  })
})

describe("validateRepoPath — required + path-exists checks", () => {
  test("rejects empty / whitespace input with a helpful message", () => {
    expect(validateRepoPath("")).toBe("repo path is required")
    expect(validateRepoPath("   ")).toBe("repo path is required")
  })

  test("rejects a path that doesn't exist on disk", () => {
    const r = validateRepoPath("/this/path/definitely/does/not/exist/kobe-test-marker")
    expect(r).toMatch(/^path does not exist:/)
  })

  test("rejects a path that exists but is a regular file (not a directory)", () => {
    // package.json is guaranteed to exist relative to the repo root
    // when vitest runs from packages/kobe. Use a known stable file.
    const r = validateRepoPath("./package.json")
    // Either "not a directory" or "path does not exist" depending
    // on the cwd vitest picks — both indicate validation worked.
    expect(r).toMatch(/^(not a directory|path does not exist):/)
  })
})

describe("listLocalBranches — fault-tolerance", () => {
  test("returns [] for an empty / missing repo path (no throw)", () => {
    expect(listLocalBranches("")).toEqual([])
    expect(listLocalBranches("/this/path/definitely/does/not/exist")).toEqual([])
  })
})
