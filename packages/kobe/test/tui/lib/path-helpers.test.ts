/**
 * Unit tests for `src/tui/lib/path-helpers.ts` — the path/dir
 * suggestion plumbing behind the new-task dialog's browse-mode picker
 * and `kobe quick-task`'s repo resolution.
 *
 * Why these matter: this module was split out of the dialog's state.ts
 * junk drawer; it's now a shared lib, so regressions here break two
 * surfaces at once. `splitPathForDirSuggest` + `joinDrill` together
 * implement the "type a path, drill with enter" loop — the split tests
 * (moved here from new-task-dialog/state.test.ts) pin the
 * trailing-slash and partial-leaf cases, and the joinDrill tests pin
 * the `~/` round-trip (expand for readdir, rewrap for display) that
 * keeps the rendered input readable.
 */

import * as os from "node:os"
import { expandHome, filterSubdirs, joinDrill, splitPathForDirSuggest } from "@/tui/lib/path-helpers"
import { describe, expect, it } from "vitest"

describe("expandHome", () => {
  it("expands bare ~ and ~/-prefixed paths", () => {
    expect(expandHome("~")).toBe(os.homedir())
    expect(expandHome("~/code")).toBe(`${os.homedir()}/code`)
  })

  it("leaves absolute and ~user paths alone", () => {
    expect(expandHome("/tmp/x")).toBe("/tmp/x")
    expect(expandHome("~other/x")).toBe("~other/x")
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

  it("treats bare ~ as the home directory listing", () => {
    const split = splitPathForDirSuggest("~")
    expect(split.base).toBe(`${os.homedir()}/`)
    expect(split.filter).toBe("")
  })

  it("expands ~/-relative inputs so readdir gets a real path", () => {
    const split = splitPathForDirSuggest("~/p")
    expect(split.base).toBe(`${os.homedir()}/`)
    expect(split.filter).toBe("p")
  })

  it("handles slash-less input as a pure filter with no base", () => {
    expect(splitPathForDirSuggest("foo")).toEqual({ base: "", filter: "foo" })
    expect(splitPathForDirSuggest("")).toEqual({ base: "", filter: "" })
  })
})

describe("filterSubdirs", () => {
  const all = [".git", ".config", "Apps", "projects", "my-projects"]

  it("hides dotdirs unless the filter starts with a dot", () => {
    expect(filterSubdirs(all, "")).toEqual(["Apps", "projects", "my-projects"])
    expect(filterSubdirs(all, ".")).toEqual([".git", ".config"])
  })

  it("prefix-matches case-insensitively (not substring)", () => {
    expect(filterSubdirs(all, "proj")).toEqual(["projects"]) // not my-projects
    expect(filterSubdirs(all, "app")).toEqual(["Apps"])
  })
})

describe("joinDrill", () => {
  it("appends the picked dir with a trailing slash", () => {
    expect(joinDrill("/tmp/", "/tmp/", "repo")).toBe("/tmp/repo/")
  })

  it("rewraps home-relative results in ~/ when the user typed ~", () => {
    const home = os.homedir()
    expect(joinDrill("~/", `${home}/`, "code")).toBe("~/code/")
  })

  it("keeps absolute display when the user typed an absolute path", () => {
    const home = os.homedir()
    expect(joinDrill(`${home}/`, `${home}/`, "code")).toBe(`${home}/code/`)
  })
})
