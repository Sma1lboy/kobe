import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  CURRENT_VERSION,
  PACKAGE_NAME,
  checkLatestVersion,
  compareSemver,
  fetchReleaseNotes,
  fetchReleaseNotesRange,
  fetchReleaseSummaries,
  isNewerSemver,
  recommendedGlobalInstallCommand,
  releasePageUrl,
  repoSlug,
} from "../src/version.ts"

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

describe("checkLatestVersion — dev suppression and the KOBE_FAKE_UPDATE debug hook", () => {
  const ORIGINAL_FAKE = process.env.KOBE_FAKE_UPDATE

  beforeEach(() => {
    Reflect.deleteProperty(process.env, "KOBE_DEV")
    Reflect.deleteProperty(process.env, "KOBE_FAKE_UPDATE")
  })

  afterEach(() => {
    if (ORIGINAL_KOBE_DEV === undefined) Reflect.deleteProperty(process.env, "KOBE_DEV")
    else process.env.KOBE_DEV = ORIGINAL_KOBE_DEV
    if (ORIGINAL_FAKE === undefined) Reflect.deleteProperty(process.env, "KOBE_FAKE_UPDATE")
    else process.env.KOBE_FAKE_UPDATE = ORIGINAL_FAKE
    vi.unstubAllGlobals()
  })

  it("KOBE_FAKE_UPDATE bypasses the network entirely and compares by semver", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    process.env.KOBE_FAKE_UPDATE = "999.0.0"
    await expect(checkLatestVersion()).resolves.toEqual({
      current: CURRENT_VERSION,
      latest: "999.0.0",
      hasUpdate: true,
    })
    process.env.KOBE_FAKE_UPDATE = "0.0.1"
    await expect(checkLatestVersion()).resolves.toMatchObject({ hasUpdate: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("KOBE_DEV=1 suppresses the check unless force is passed", async () => {
    process.env.KOBE_DEV = "1"
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: "999.0.0" }), { status: 200 }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(checkLatestVersion()).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()

    await expect(checkLatestVersion({ force: true })).resolves.toMatchObject({ latest: "999.0.0" })
  })

  it("returns null on registry failure, malformed body, and network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    )
    await expect(checkLatestVersion()).resolves.toBeNull()

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ version: 42 }), { status: 200 })),
    )
    await expect(checkLatestVersion()).resolves.toBeNull()

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline")
      }),
    )
    await expect(checkLatestVersion()).resolves.toBeNull()
  })
})

describe("semver helpers", () => {
  it("compares plain x.y.z and strips pre-release identifiers", () => {
    expect(isNewerSemver("1.2.3", "1.2.2")).toBe(true)
    expect(isNewerSemver("1.2.2", "1.2.3")).toBe(false)
    expect(compareSemver("1.2.3-rc.1", "1.2.3")).toBe(0)
    expect(compareSemver("2.0.0", "10.0.0")).toBe(-1)
  })

  it("treats an unparseable component as equal (no false update chip)", () => {
    expect(compareSemver("abc", "1.0.0")).toBe(0)
  })
})

describe("repo slug + static commands", () => {
  it("derives owner/repo from package.json#repository.url", () => {
    expect(repoSlug()).toBe("Sma1lboy/kobe")
  })

  it("recommendedGlobalInstallCommand targets this package", () => {
    expect(recommendedGlobalInstallCommand()).toBe(`npm install -g ${PACKAGE_NAME}@latest`)
  })

  it("releasePageUrl points at the GitHub tag for a version", () => {
    expect(releasePageUrl("0.1.2")).toBe("https://github.com/Sma1lboy/kobe/releases/tag/v0.1.2")
  })
})

describe("fetchReleaseNotes", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns the release body + html_url for vX.Y.Z", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.github.com/repos/Sma1lboy/kobe/releases/tags/v0.7.12")
      return new Response(JSON.stringify({ body: "notes!", html_url: "https://gh/rel/v0.7.12" }), { status: 200 })
    })
    vi.stubGlobal("fetch", fetchMock)
    await expect(fetchReleaseNotes("0.7.12")).resolves.toEqual({
      body: "notes!",
      url: "https://gh/rel/v0.7.12",
      version: "0.7.12",
    })
  })

  it("returns null on a missing release, malformed body, or network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    )
    await expect(fetchReleaseNotes("9.9.9")).resolves.toBeNull()

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ body: 42 }), { status: 200 })),
    )
    await expect(fetchReleaseNotes("9.9.9")).resolves.toBeNull()

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline")
      }),
    )
    await expect(fetchReleaseNotes("9.9.9")).resolves.toBeNull()
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

  it("falls back to an empty list on a non-array body and on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "rate limited" }), { status: 200 })),
    )
    await expect(fetchReleaseSummaries()).resolves.toEqual([])

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline")
      }),
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

  it("falls back to an empty list on a non-array body and on a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "rate limited" }), { status: 200 })),
    )
    await expect(fetchReleaseNotesRange({ current: "0.7.10", latest: "0.7.12" })).resolves.toEqual([])

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline")
      }),
    )
    await expect(fetchReleaseNotesRange({ current: "0.7.10", latest: "0.7.12" })).resolves.toEqual([])
  })
})
