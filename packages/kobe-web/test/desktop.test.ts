// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest"
import { enableDesktopMode, isDesktopSearch } from "../src/lib/desktop.ts"

describe("desktop mode", () => {
  afterEach(() => {
    delete document.documentElement.dataset.kobeDesktop
  })

  it("is enabled only by the desktop query marker", () => {
    expect(isDesktopSearch("?kobeDesktop=1")).toBe(true)
    expect(isDesktopSearch("?kobeDesktop=0")).toBe(false)
    expect(isDesktopSearch("?foo=1")).toBe(false)
  })

  it("marks the document for desktop-only chrome styles", () => {
    expect(enableDesktopMode("?kobeDesktop=1")).toBe(true)
    expect(document.documentElement.dataset.kobeDesktop).toBe("true")
  })

  it("leaves browser mode unmarked", () => {
    expect(enableDesktopMode("?")).toBe(false)
    expect(document.documentElement.dataset.kobeDesktop).toBeUndefined()
  })
})
