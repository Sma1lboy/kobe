import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchDiff } from "../src/lib/diff.ts"

/**
 * The diff client builds the /api/diff query (worktreePath + the namesOnly/path
 * hints) and normalizes the response. Lock the request shape + error handling.
 */

function mockFetch(impl: (url: string) => { ok: boolean; body: unknown }) {
  vi.stubGlobal("fetch", (url: string) => {
    const { ok, body } = impl(url)
    return Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      json: () => Promise.resolve(body),
    } as Response)
  })
}

afterEach(() => vi.unstubAllGlobals())

describe("fetchDiff", () => {
  it("sends worktreePath and omits hints by default", async () => {
    let seen = ""
    mockFetch((url) => {
      seen = url
      return { ok: true, body: { files: [], raw: "" } }
    })
    await fetchDiff("/abs/wt")
    expect(seen).toContain("worktreePath=%2Fabs%2Fwt")
    expect(seen).not.toContain("namesOnly")
    expect(seen).not.toContain("path=")
  })

  it("adds namesOnly=1 and path when requested", async () => {
    let seen = ""
    mockFetch((url) => {
      seen = url
      return { ok: true, body: { files: [], raw: "" } }
    })
    await fetchDiff("/wt", { namesOnly: true, path: "src/a.ts" })
    expect(seen).toContain("namesOnly=1")
    expect(seen).toContain("path=src%2Fa.ts")
  })

  it("normalizes a sparse response to files[] + raw", async () => {
    mockFetch(() => ({ ok: true, body: {} }))
    expect(await fetchDiff("/wt")).toEqual({ files: [], raw: "" })
  })

  it("throws the server error message on a JSON error", async () => {
    mockFetch(() => ({ ok: false, body: { error: "not a git worktree" } }))
    await expect(fetchDiff("/wt")).rejects.toThrow("not a git worktree")
  })

  it("throws a status fallback when there's no error message", async () => {
    mockFetch(() => ({ ok: false, body: {} }))
    await expect(fetchDiff("/wt")).rejects.toThrow(/500/)
  })
})
