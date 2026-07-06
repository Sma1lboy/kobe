import * as os from "node:os"
import { expandHome, filterSubdirs, joinDrill, joinPicked, splitPathForDirSuggest } from "@/tui/lib/path-helpers"
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
    expect(filterSubdirs(all, "proj")).toEqual(["projects"])
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

describe("joinPicked (select, don't drill — no trailing slash)", () => {
  it("appends the picked dir WITHOUT a trailing slash so the dropdown collapses", () => {
    expect(joinPicked("/tmp/", "/tmp/", "repo")).toBe("/tmp/repo")
  })

  it("rewraps home-relative results in ~/ when the user typed ~", () => {
    const home = os.homedir()
    expect(joinPicked("~/", `${home}/`, "code")).toBe("~/code")
  })

  it("collapses a pick AT the home root back to bare ~", () => {
    const home = os.homedir()
    const parent = `${home.slice(0, home.lastIndexOf("/") + 1)}`
    const leaf = home.slice(home.lastIndexOf("/") + 1)
    expect(joinPicked("~", parent, leaf)).toBe("~")
  })

  it("keeps absolute display when the user typed an absolute path", () => {
    const home = os.homedir()
    expect(joinPicked(`${home}/`, `${home}/`, "code")).toBe(`${home}/code`)
  })
})
