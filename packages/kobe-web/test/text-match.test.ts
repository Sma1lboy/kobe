import { describe, expect, it } from "vitest"
import { textMatchesQuery } from "../src/lib/text-match.ts"


describe("textMatchesQuery", () => {
  it("matches everything for a blank or whitespace-only query", () => {
    expect(textMatchesQuery("anything", "")).toBe(true)
    expect(textMatchesQuery("anything", "   ")).toBe(true)
  })

  it("is case-insensitive and substring", () => {
    expect(textMatchesQuery("Fix the LOGIN bug", "login")).toBe(true)
    expect(textMatchesQuery("Fix the login bug", "LOGIN")).toBe(true)
    expect(textMatchesQuery("Fix the login bug", "bug")).toBe(true)
  })

  it("trims the query before matching", () => {
    expect(textMatchesQuery("login", "  login  ")).toBe(true)
  })

  it("returns false when the haystack lacks the query", () => {
    expect(textMatchesQuery("Fix the login bug", "logout")).toBe(false)
  })
})
