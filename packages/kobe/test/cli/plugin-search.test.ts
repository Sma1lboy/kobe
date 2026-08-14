import { afterEach, describe, expect, it, vi } from "vitest"
import { searchMarketplace } from "../../src/cli/plugin-search.ts"

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("plugin marketplace compatibility", () => {
  it("unions the Rove and legacy Kobe topics and de-duplicates repositories", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const legacy = url.includes("topic%3Akobe-plugin")
      return {
        ok: true,
        json: async () => ({
          items: [
            { full_name: "you/shared", description: "shared", stargazers_count: legacy ? 1 : 2 },
            ...(legacy ? [{ full_name: "you/legacy", description: "legacy", stargazers_count: 3 }] : []),
          ],
        }),
      }
    })
    vi.stubGlobal("fetch", fetchMock)
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    await searchMarketplace("needle")

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("topic%3Arove-plugin"),
        expect.stringContaining("topic%3Akobe-plugin"),
      ]),
    )
    const output = log.mock.calls.map(([line]) => String(line)).join("\n")
    expect(output.match(/you\/shared/g)).toHaveLength(1)
    expect(output).toContain("you/legacy")
  })

  it("keeps first-party fallback results when both topic searches fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("offline"))),
    )
    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(console, "error").mockImplementation(() => {})

    await searchMarketplace(undefined)

    expect(log.mock.calls.map(([line]) => String(line)).join("\n")).toContain("Sma1lboy/kobe-plugins/notify")
  })
})
