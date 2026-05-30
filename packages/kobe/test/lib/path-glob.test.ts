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
})
