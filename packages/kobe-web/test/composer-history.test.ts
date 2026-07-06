import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  loadHistory,
  navigateHistory,
  pushHistory,
} from "../src/lib/composer-history.ts"

function makeStorage() {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  }
}

beforeEach(() => vi.stubGlobal("localStorage", makeStorage()))
afterEach(() => vi.unstubAllGlobals())

describe("navigateHistory (pure cursor walk)", () => {
  const hist = ["newest", "mid", "oldest"]

  it("walks up through older prompts", () => {
    expect(navigateHistory(hist, -1, "up", "draft")).toEqual({
      cursor: 0,
      value: "newest",
    })
    expect(navigateHistory(hist, 0, "up", "draft")).toEqual({
      cursor: 1,
      value: "mid",
    })
  })

  it("stops at the oldest (returns null so the arrow falls through)", () => {
    expect(navigateHistory(hist, 2, "up", "draft")).toBeNull()
  })

  it("walks down and restores the live draft at the bottom", () => {
    expect(navigateHistory(hist, 1, "down", "draft")).toEqual({
      cursor: 0,
      value: "newest",
    })
    expect(navigateHistory(hist, 0, "down", "draft")).toEqual({
      cursor: -1,
      value: "draft",
    })
  })

  it("does nothing on down from the live draft, or up with empty history", () => {
    expect(navigateHistory(hist, -1, "down", "draft")).toBeNull()
    expect(navigateHistory([], -1, "up", "draft")).toBeNull()
  })
})

describe("loadHistory / pushHistory (localStorage)", () => {
  it("round-trips newest-first", () => {
    pushHistory("t1", "first")
    pushHistory("t1", "second")
    expect(loadHistory("t1")).toEqual(["second", "first"])
  })

  it("ignores a blank prompt", () => {
    pushHistory("t1", "real")
    pushHistory("t1", "   ")
    expect(loadHistory("t1")).toEqual(["real"])
  })

  it("collapses an immediate duplicate of the newest", () => {
    pushHistory("t1", "same")
    pushHistory("t1", "same")
    expect(loadHistory("t1")).toEqual(["same"])
  })

  it("keeps history separate per task", () => {
    pushHistory("a", "for-a")
    pushHistory("b", "for-b")
    expect(loadHistory("a")).toEqual(["for-a"])
    expect(loadHistory("b")).toEqual(["for-b"])
  })

  it("returns [] for an unknown task and survives corrupt storage", () => {
    expect(loadHistory("never")).toEqual([])
    localStorage.setItem("kobe-web.composer-history.bad", "{not json")
    expect(loadHistory("bad")).toEqual([])
  })

  it("caps history at 50 entries, keeping the newest", () => {
    for (let i = 0; i < 60; i++) pushHistory("t1", `prompt ${i}`)
    const hist = loadHistory("t1")
    expect(hist).toHaveLength(50)
    expect(hist[0]).toBe("prompt 59")
    expect(hist).not.toContain("prompt 9")
  })

  it("ignores a non-array stored value", () => {
    localStorage.setItem("kobe-web.composer-history.weird", '"a string"')
    expect(loadHistory("weird")).toEqual([])
  })
})
