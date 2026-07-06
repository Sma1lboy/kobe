import { describe, expect, it } from "vitest"
import { globToRegExp, matchPathGlob } from "../../src/lib/path-glob.ts"

describe("globToRegExp", () => {
  it("treats `*` as any run except a slash", () => {
    const re = globToRegExp("*.ts")
    expect(re.test("a.ts")).toBe(true)
    expect(re.test("a/b.ts")).toBe(false)
  })

  it("treats `**` as any run including slashes", () => {
    const re = globToRegExp("a/**")
    expect(re.test("a/b")).toBe(true)
    expect(re.test("a/b/c")).toBe(true)
  })

  it("lets an interior `**` match zero intervening directories", () => {
    const re = globToRegExp("src/**/task.ts")
    expect(re.test("src/task.ts")).toBe(true) // zero directories between
    expect(re.test("src/a/task.ts")).toBe(true)
    expect(re.test("src/a/b/task.ts")).toBe(true)
    expect(re.test("srctask.ts")).toBe(false) // separator is still required
    expect(re.test("src/task.tsx")).toBe(false) // still anchored
  })

  it("lets a leading `**/` match zero or more leading directories", () => {
    const re = globToRegExp("**/task.ts")
    expect(re.test("task.ts")).toBe(true)
    expect(re.test("a/task.ts")).toBe(true)
    expect(re.test("a/b/task.ts")).toBe(true)
  })

  it("keeps loose `**` semantics when it is not its own segment", () => {
    const re = globToRegExp("a**b")
    expect(re.test("a-x/y-b")).toBe(true) // still crosses slashes
    expect(re.test("axb")).toBe(true)
  })

  it("treats `?` as a single non-slash char", () => {
    const re = globToRegExp("?.ts")
    expect(re.test("a.ts")).toBe(true)
    expect(re.test("ab.ts")).toBe(false)
    expect(re.test("/.ts")).toBe(false)
  })

  it("escapes regex metacharacters so they match literally", () => {
    const re = globToRegExp("a.b+c")
    expect(re.test("a.b+c")).toBe(true)
    expect(re.test("axbxc")).toBe(false)
  })

  it("anchors the whole string", () => {
    const re = globToRegExp("foo")
    expect(re.test("foo")).toBe(true)
    expect(re.test("foobar")).toBe(false)
    expect(re.test("xfoo")).toBe(false)
  })
})

describe("matchPathGlob", () => {
  it("matches against the full path", () => {
    expect(matchPathGlob("/work/**", "/work/a/b")).toBe(true)
  })

  it("falls back to matching the basename", () => {
    expect(matchPathGlob("feature-*", "/work/feature-login")).toBe(true)
  })

  it("returns false when neither the path nor its basename matches", () => {
    expect(matchPathGlob("x-*", "/work/feature-login")).toBe(false)
  })

  it("does not let `*` cross directory separators", () => {
    expect(matchPathGlob("/a/*", "/a/b/c")).toBe(false)
  })

  it("matches a nested `**` filter against a worktree directly under the prefix", () => {
    // Regression: `src/**/login` previously failed to match `/work/src/login`
    // because the globstar required at least one intervening directory.
    expect(matchPathGlob("/work/**/login", "/work/login")).toBe(true)
    expect(matchPathGlob("/work/**/login", "/work/feature/login")).toBe(true)
  })
})
