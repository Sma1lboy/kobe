import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checkLatestVersion, fetchReleaseNotesRange, fetchReleaseSummaries } from "../src/version.ts"

const ORIGINAL_KOBE_DEV = process.env.KOBE_DEV

describe("checkLatestVersion", () => {
  beforeEach(() => {
    Reflect.deleteProperty(process.env, "KOBE_DEV")
  })

  afterEach(() => {
    if (ORIGINAL_KOBE_DEV === undefined) {
      Reflect.deleteProperty(process.env, "KOBE_DEV")
    } else {
      process.env.KOBE_DEV = ORIGINAL_KOBE_DEV
    }
    vi.unstubAllGlobals()
  })

  it("queries the npm registry every time so the topbar does not miss fresh releases", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(JSON.stringify({ version: "999.0.0" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(checkLatestVersion()).resolves.toMatchObject({
      latest: "999.0.0",
      hasUpdate: true,
    })
    await expect(checkLatestVersion()).resolves.toMatchObject({
      latest: "999.0.0",
      hasUpdate: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe("fetchReleaseSummaries", () => {
  beforeEach(() => {
    Reflect.deleteProperty(process.env, "KOBE_DEV")
  })

  afterEach(() => {
    if (ORIGINAL_KOBE_DEV === undefined) {
      Reflect.deleteProperty(process.env, "KOBE_DEV")
    } else {
      process.env.KOBE_DEV = ORIGINAL_KOBE_DEV
    }
    vi.unstubAllGlobals()
  })

  it("normalizes GitHub release tags into plain semver versions", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          { tag_name: "v0.5.23", html_url: "https://github.com/Sma1lboy/kobe/releases/tag/v0.5.23" },
          { tag_name: "not-a-version", html_url: "https://example.test/bad" },
          { tag_name: "v0.5.22", html_url: "https://github.com/Sma1lboy/kobe/releases/tag/v0.5.22" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchReleaseSummaries()).resolves.toEqual([
      { version: "0.5.23", url: "https://github.com/Sma1lboy/kobe/releases/tag/v0.5.23" },
      { version: "0.5.22", url: "https://github.com/Sma1lboy/kobe/releases/tag/v0.5.22" },
    ])
  })

  it("falls back to an empty list on API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    )
    await expect(fetchReleaseSummaries()).resolves.toEqual([])
  })
})

describe("fetchReleaseNotesRange", () => {
  beforeEach(() => {
    Reflect.deleteProperty(process.env, "KOBE_DEV")
  })

  afterEach(() => {
    if (ORIGINAL_KOBE_DEV === undefined) {
      Reflect.deleteProperty(process.env, "KOBE_DEV")
    } else {
      process.env.KOBE_DEV = ORIGINAL_KOBE_DEV
    }
    vi.unstubAllGlobals()
  })

  it("returns every release newer than current through latest", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify([
          { tag_name: "v0.7.12", html_url: "https://github.com/Sma1lboy/kobe/releases/tag/v0.7.12", body: "latest" },
          { tag_name: "v0.7.11", html_url: "https://github.com/Sma1lboy/kobe/releases/tag/v0.7.11", body: "middle" },
          { tag_name: "v0.7.10", html_url: "https://github.com/Sma1lboy/kobe/releases/tag/v0.7.10", body: "current" },
          { tag_name: "v0.7.9", html_url: "https://github.com/Sma1lboy/kobe/releases/tag/v0.7.9", body: "old" },
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    })
    vi.stubGlobal("fetch", fetchMock)

    await expect(fetchReleaseNotesRange({ current: "0.7.10", latest: "0.7.12" })).resolves.toEqual([
      { version: "0.7.12", url: "https://github.com/Sma1lboy/kobe/releases/tag/v0.7.12", body: "latest" },
      { version: "0.7.11", url: "https://github.com/Sma1lboy/kobe/releases/tag/v0.7.11", body: "middle" },
    ])
  })

  it("falls back to an empty list on API failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    )
    await expect(fetchReleaseNotesRange({ current: "0.7.10", latest: "0.7.12" })).resolves.toEqual([])
  })
})
