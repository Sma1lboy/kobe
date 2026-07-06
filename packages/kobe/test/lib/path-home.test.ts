import path from "node:path"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { expandTilde } from "../../src/lib/path-home.ts"

let prevHome: string | undefined
const HOME = path.join(path.sep, "tmp", "kobe-home-fixture")

beforeEach(() => {
  prevHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = HOME
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
})

describe("expandTilde", () => {
  test("expands a bare `~` to the home directory", () => {
    expect(expandTilde("~")).toBe(HOME)
  })

  test("expands a `~/…` prefix, joining the remainder onto home", () => {
    expect(expandTilde("~/myrepo")).toBe(path.join(HOME, "myrepo"))
    expect(expandTilde("~/a/b/c")).toBe(path.join(HOME, "a", "b", "c"))
  })

  test("leaves absolute and relative paths untouched", () => {
    expect(expandTilde("/abs/path")).toBe("/abs/path")
    expect(expandTilde("relative/path")).toBe("relative/path")
    expect(expandTilde(".")).toBe(".")
    expect(expandTilde("")).toBe("")
  })

  test("does not expand `~user` (no username lookup)", () => {
    expect(expandTilde("~user/repo")).toBe("~user/repo")
    expect(expandTilde("~-foo")).toBe("~-foo")
  })

  test("only a *leading* `~` is special — an interior `~` is literal", () => {
    expect(expandTilde("a/~/b")).toBe("a/~/b")
    expect(expandTilde("foo~bar")).toBe("foo~bar")
  })

  test("the regression: resolving a quoted `~/repo` no longer yields `<cwd>/~/repo`", () => {
    const cwd = "/some/cwd"
    expect(resolve(cwd, expandTilde("~/repo"))).toBe(path.join(HOME, "repo"))
    expect(resolve(cwd, expandTilde("~/repo"))).not.toContain("~")
  })
})
