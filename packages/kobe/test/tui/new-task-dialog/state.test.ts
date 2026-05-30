/**
 * Unit tests for new-task-dialog pure helpers (`src/tui/component/
 * new-task-dialog/state.ts`).
 *
 * Focus: the picker mode logic the first-run flow leans on (KOB-250).
 * With no saved repos the dialog defaults to the cwd — saved mode
 * preselects it, and typing a `/` flips the picker into browse mode so
 * the user drills into directories in-TUI instead of running `kobe add`
 * from a shell. We pin:
 *   - `pickerModeFor` returns "saved" for an exact saved-repo match
 *     (the cwd-preselected state) and "browse" once the input looks
 *     like a path.
 *   - `splitPathForDirSuggest` splits a typed path into the directory to
 *     readdir + the partial leaf to filter — including the trailing-slash
 *     case that lists a directory's own children.
 *   - `computeRepoOptions` always surfaces the cwd even with no saved
 *     repos, so the first-run picker is never empty.
 */

import {
  computeRepoOptions,
  filterAdoptableByGlob,
  nextDialogTab,
  pickerModeFor,
  splitPathForDirSuggest,
} from "@/tui/component/new-task-dialog/state"
import { describe, expect, it } from "vitest"

describe("filterAdoptableByGlob (KOB-256)", () => {
  const list = [
    { path: "/work/repo/.claude/worktrees/panda" },
    { path: "/work/feature-login" },
    { path: "/work/feature-signup" },
    { path: "/elsewhere/bugfix" },
  ]
  it("returns the full list for an empty glob", () => {
    expect(filterAdoptableByGlob(list, "")).toHaveLength(4)
    expect(filterAdoptableByGlob(list, "  ")).toHaveLength(4)
  })
  it("matches on basename so a bare pattern works", () => {
    expect(filterAdoptableByGlob(list, "feature-*").map((w) => w.path)).toEqual([
      "/work/feature-login",
      "/work/feature-signup",
    ])
  })
  it("matches on absolute path globs", () => {
    expect(filterAdoptableByGlob(list, "/work/**").map((w) => w.path)).toEqual([
      "/work/repo/.claude/worktrees/panda",
      "/work/feature-login",
      "/work/feature-signup",
    ])
  })
})

describe("nextDialogTab (KOB-256: 3-tab cycle)", () => {
  it("cycles existing → clone → adopt → existing", () => {
    expect(nextDialogTab("existing")).toBe("clone")
    expect(nextDialogTab("clone")).toBe("adopt")
    expect(nextDialogTab("adopt")).toBe("existing")
  })
})

describe("pickerModeFor", () => {
  it("stays in saved mode when the input exactly matches a saved repo", () => {
    const cwd = "/home/me/proj"
    expect(pickerModeFor(cwd, [cwd])).toBe("saved")
  })

  it("flips to browse mode once the input looks like a path", () => {
    expect(pickerModeFor("/home/me/proj/", ["/home/me/proj"])).toBe("browse")
    expect(pickerModeFor("~/code", [])).toBe("browse")
  })

  it("treats a short non-path query as saved (substring filter)", () => {
    expect(pickerModeFor("proj", ["/home/me/proj"])).toBe("saved")
  })
})

describe("splitPathForDirSuggest", () => {
  it("lists a directory's own children when the input ends in a slash", () => {
    const split = splitPathForDirSuggest("/home/me/proj/")
    expect(split.base).toBe("/home/me/proj/")
    expect(split.filter).toBe("")
  })

  it("splits a partially-typed leaf off the base directory", () => {
    const split = splitPathForDirSuggest("/home/me/pr")
    expect(split.base).toBe("/home/me/")
    expect(split.filter).toBe("pr")
  })
})

describe("computeRepoOptions", () => {
  it("surfaces the cwd even with no saved repos (first-run picker is never empty)", () => {
    const cwd = "/home/me/proj"
    expect(computeRepoOptions(cwd, [])).toEqual([cwd])
  })

  it("dedupes the cwd against the saved list and keeps it first", () => {
    const cwd = "/home/me/proj"
    expect(computeRepoOptions(cwd, [cwd, "/home/me/other"])).toEqual([cwd, "/home/me/other"])
  })
})
