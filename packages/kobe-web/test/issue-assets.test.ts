import { afterEach, describe, expect, it, vi } from "vitest"
import { uploadIssueAsset } from "../src/lib/issue-assets.ts"


const png = (): File =>
  new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "shot.png", {
    type: "image/png",
  })

describe("uploadIssueAsset", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("POSTs multipart (repoRoot + file), no hand-set Content-Type, returns the url", async () => {
    const url = "/api/issue-assets/0123456789abcdef/shot.png"
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify({ url }))),
    )
    vi.stubGlobal("fetch", fetchMock)

    const result = await uploadIssueAsset("/u/p/kobe", png())
    expect(result).toEqual({ url })

    const [calledUrl, init] = fetchMock.mock.calls[0]
    expect(calledUrl).toBe("/api/issue-assets")
    expect((init as RequestInit).method).toBe("POST")
    const body = (init as RequestInit).body as FormData
    expect(body).toBeInstanceOf(FormData)
    expect(body.get("repoRoot")).toBe("/u/p/kobe")
    expect(body.get("file")).toBeInstanceOf(File)
    expect((init as RequestInit).headers).toBeUndefined()
  })

  it("throws with the server's error text on a non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response("file too large", { status: 413 })),
      ),
    )
    await expect(uploadIssueAsset("/u/p/kobe", png())).rejects.toThrow(
      /file too large/,
    )
  })

  it("throws when the ok response carries no usable url", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ url: "" })))),
    )
    await expect(uploadIssueAsset("/u/p/kobe", png())).rejects.toThrow(
      /no url/,
    )
  })

  it("throws when the ok response url is the wrong type", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response(JSON.stringify({ url: 7 })))),
    )
    await expect(uploadIssueAsset("/u/p/kobe", png())).rejects.toThrow(
      /no url/,
    )
  })
})
