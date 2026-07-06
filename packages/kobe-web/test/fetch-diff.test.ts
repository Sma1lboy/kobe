import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchDiff } from "../src/lib/diff.ts"

/** Capture the URL fetchDiff builds and return a canned diff payload. */
function stubFetch(payload: unknown = { files: [] }, ok = true) {
  const calls: string[] = []
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    calls.push(String(url))
    return new Response(JSON.stringify(payload), { status: ok ? 200 : 500 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("fetchDiff query construction", () => {
  it("sends only the worktreePath when no options are given", () => {
    const { calls } = stubFetch()
    void fetchDiff("/abs/work tree")
    const url = new URL(calls[0], "http://x")
    expect(url.pathname).toBe("/api/diff")
    expect(url.searchParams.get("worktreePath")).toBe("/abs/work tree")
    expect(url.searchParams.has("path")).toBe(false)
    expect(url.searchParams.has("namesOnly")).toBe(false)
  })

  it("adds ?path=<rel> when scoped to one file (FilePreview)", () => {
    const { calls } = stubFetch()
    void fetchDiff("/abs/wt", { path: "src/a b.ts" })
    const url = new URL(calls[0], "http://x")
    expect(url.searchParams.get("worktreePath")).toBe("/abs/wt")
    expect(url.searchParams.get("path")).toBe("src/a b.ts")
    expect(url.searchParams.has("namesOnly")).toBe(false)
  })

  it("adds ?namesOnly=1 for the changes list", () => {
    const { calls } = stubFetch()
    void fetchDiff("/abs/wt", { namesOnly: true })
    const url = new URL(calls[0], "http://x")
    expect(url.searchParams.get("namesOnly")).toBe("1")
    expect(url.searchParams.has("path")).toBe(false)
  })

  it("normalizes a partial/forward-compat payload to the full result shape", async () => {
    // A namesOnly response may omit patches; fetchDiff fills defaults so
    // callers always get { files }.
    stubFetch({ files: [{ path: "a", status: "added", staged: false, patch: "" }] })
    const result = await fetchDiff("/abs/wt", { namesOnly: true })
    expect(result.files).toHaveLength(1)
    expect(result.files[0].path).toBe("a")
  })

  it("throws the server error message on a non-OK response", async () => {
    stubFetch({ error: "not a git work tree" }, false)
    await expect(fetchDiff("/abs/wt")).rejects.toThrow("not a git work tree")
  })
})
