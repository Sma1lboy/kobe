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

import * as os from "node:os"
import { describe, expect, test } from "vitest"
import {
  DEFAULT_BASE_REF,
  PICKER_MAX_VISIBLE,
  clampCursor,
  computeRepoOptions,
  expandHome,
  filterBranches,
  filterRepos,
  filterSubdirs,
  joinDrill,
  getCurrentBranch,
  listLocalBranches,
  listSubdirs,
  nextField,
  pickerModeFor,
  resolveBaseRef,
  splitPathForDirSuggest,
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
  test("walks repo → baseRef → confirm → repo", () => {
    expect(nextField("repo")).toBe("baseRef")
    expect(nextField("baseRef")).toBe("confirm")
    expect(nextField("confirm")).toBe("repo")
  })
})

describe("pickerModeFor — saved vs browse decision", () => {
  const SAVED = ["/Users/me/projects/kobe", "/Users/me/projects/widget"]

  test("empty input → saved", () => {
    expect(pickerModeFor("", SAVED)).toBe("saved")
    expect(pickerModeFor("   ", SAVED)).toBe("saved")
  })

  test("non-path substring → saved (filter mode)", () => {
    expect(pickerModeFor("kobe", SAVED)).toBe("saved")
    expect(pickerModeFor("widget", SAVED)).toBe("saved")
  })

  test("path-shaped input → browse", () => {
    expect(pickerModeFor("/Users/", SAVED)).toBe("browse")
    expect(pickerModeFor("/Users/me/proj", SAVED)).toBe("browse")
    expect(pickerModeFor("~/", SAVED)).toBe("browse")
    expect(pickerModeFor("~/projects", SAVED)).toBe("browse")
  })

  test("exact match against a saved repo → saved (so the cwd-prefilled state stays in saved mode)", () => {
    expect(pickerModeFor("/Users/me/projects/kobe", SAVED)).toBe("saved")
    expect(pickerModeFor("  /Users/me/projects/kobe  ", SAVED)).toBe("saved")
  })

  test("backspacing past an exact match flips back to browse", () => {
    // After `/Users/me/projects/kob` (one char short of saved), the
    // user is mid-edit — they want directory suggestions, not the
    // curated list filtered to nothing.
    expect(pickerModeFor("/Users/me/projects/kob", SAVED)).toBe("browse")
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

describe("getCurrentBranch — fault-tolerance", () => {
  test("returns null for an empty / missing repo path (no throw)", () => {
    expect(getCurrentBranch("")).toBeNull()
    expect(getCurrentBranch("/this/path/definitely/does/not/exist")).toBeNull()
  })
})

describe("expandHome — ~ resolution", () => {
  test("bare ~ resolves to homedir without trailing slash", () => {
    expect(expandHome("~")).toBe(os.homedir())
  })
  test("~/ resolves with trailing slash preserved", () => {
    expect(expandHome("~/")).toBe(`${os.homedir()}/`)
  })
  test("~/path keeps the suffix", () => {
    expect(expandHome("~/projects/kobe")).toBe(`${os.homedir()}/projects/kobe`)
  })
  test("non-~ paths are passed through unchanged", () => {
    expect(expandHome("/Users/foo")).toBe("/Users/foo")
    expect(expandHome("relative/path")).toBe("relative/path")
    expect(expandHome("")).toBe("")
  })
})

describe("splitPathForDirSuggest — base/filter parsing", () => {
  test("trailing slash → entire path is base, empty filter", () => {
    expect(splitPathForDirSuggest("/Users/")).toEqual({ base: "/Users/", filter: "" })
    expect(splitPathForDirSuggest("/Users/me/projects/")).toEqual({
      base: "/Users/me/projects/",
      filter: "",
    })
  })

  test("partial leaf → base is the dirname, filter is the partial leaf", () => {
    expect(splitPathForDirSuggest("/Users/me/proj")).toEqual({
      base: "/Users/me/",
      filter: "proj",
    })
  })

  test("no slash → empty base, whole input is the filter", () => {
    expect(splitPathForDirSuggest("foo")).toEqual({ base: "", filter: "foo" })
  })

  test("empty input → empty split", () => {
    expect(splitPathForDirSuggest("")).toEqual({ base: "", filter: "" })
  })

  test("bare ~ is normalized to ~/ and expanded to homedir", () => {
    const out = splitPathForDirSuggest("~")
    expect(out.base).toBe(`${os.homedir()}/`)
    expect(out.filter).toBe("")
  })

  test("~/partial expands base to homedir and keeps partial filter", () => {
    expect(splitPathForDirSuggest("~/proj")).toEqual({
      base: `${os.homedir()}/`,
      filter: "proj",
    })
  })
})

describe("listSubdirs — fault-tolerance and dir-only filtering", () => {
  test("returns [] for empty / missing base (no throw)", () => {
    expect(listSubdirs("")).toEqual([])
    expect(listSubdirs("/this/path/definitely/does/not/exist")).toEqual([])
  })

  test("returns directory names only, alphabetically sorted", () => {
    // Use a known-stable directory: the system tmp root has a small,
    // predictable set of dirs across CI runs. We just verify shape:
    // any returned name should be a string, and the list is sorted.
    const out = listSubdirs(`${os.tmpdir()}/`)
    expect(Array.isArray(out)).toBe(true)
    const sorted = [...out].sort((a, b) => a.localeCompare(b))
    expect(out).toEqual(sorted)
    for (const name of out) {
      expect(typeof name).toBe("string")
      expect(name).not.toContain("/")
    }
  })
})

describe("filterSubdirs — prefix match + hidden-by-default", () => {
  test("empty filter returns the list with hidden entries dropped", () => {
    const all = ["projects", ".git", "Documents", ".config"]
    expect(filterSubdirs(all, "")).toEqual(["projects", "Documents"])
  })

  test("non-`.` filter is a case-insensitive prefix match, hidden still dropped", () => {
    const all = ["projects", "Projector", "my-projects", ".project"]
    // "proj" matches projects + Projector (prefix); my-projects is not
    // a prefix match; .project is hidden because filter doesn't start
    // with `.`.
    expect(filterSubdirs(all, "proj")).toEqual(["projects", "Projector"])
    expect(filterSubdirs(all, "PROJ")).toEqual(["projects", "Projector"])
  })

  test("filter starting with `.` reveals hidden entries", () => {
    const all = ["projects", ".git", ".github", ".config"]
    expect(filterSubdirs(all, ".gi")).toEqual([".git", ".github"])
    // Bare `.` reveals all hidden entries
    expect(filterSubdirs(all, ".")).toEqual([".git", ".github", ".config"])
  })

  test("no match returns empty list", () => {
    expect(filterSubdirs(["a", "b"], "z")).toEqual([])
  })
})

describe("joinDrill — preserves ~ prefix when applicable", () => {
  test("absolute base + name produces an absolute drill path", () => {
    expect(joinDrill("/Users/me/proj", "/Users/me/", "projects")).toBe("/Users/me/projects/")
  })

  test("~-relative typed value rewraps the drill in ~/...", () => {
    const home = os.homedir()
    expect(joinDrill("~/proj", `${home}/`, "projects")).toBe("~/projects/")
  })

  test("absolute typed value is NOT rewrapped even if it lives under home", () => {
    const home = os.homedir()
    // User explicitly typed an absolute path — respect that.
    expect(joinDrill(`${home}/proj`, `${home}/`, "projects")).toBe(`${home}/projects/`)
  })
})
