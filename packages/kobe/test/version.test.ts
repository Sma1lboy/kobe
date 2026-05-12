import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checkLatestVersion } from "../src/version.ts"

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
