import { describe, expect, it } from "vitest"
import { handleHistoryRequest } from "../../src/web/history.ts"

/**
 * The history routes expose engine transcript stores to the browser, so the
 * input guards ARE the security boundary: a crafted sessionId/vendor must
 * never traverse the filesystem, and non-history paths must fall through
 * (null) so the bridge's route chain keeps working.
 */

function get(path: string): { req: Request; url: URL } {
  const url = new URL(`http://localhost${path}`)
  return { req: new Request(url), url }
}

describe("handleHistoryRequest", () => {
  it("falls through (null) for non-history paths", async () => {
    const { req, url } = get("/api/notes?taskId=abc")
    expect(await handleHistoryRequest(req, url)).toBeNull()
  })

  it("rejects non-GET methods", async () => {
    const url = new URL("http://localhost/api/history/sessions?worktreePath=/tmp&vendor=claude")
    const res = await handleHistoryRequest(new Request(url, { method: "POST" }), url)
    expect(res?.status).toBe(405)
  })

  it("rejects a relative worktreePath", async () => {
    const { req, url } = get("/api/history/sessions?worktreePath=../etc&vendor=claude")
    const res = await handleHistoryRequest(req, url)
    expect(res?.status).toBe(400)
  })

  it("rejects a missing worktreePath", async () => {
    const { req, url } = get("/api/history/sessions?vendor=claude")
    const res = await handleHistoryRequest(req, url)
    expect(res?.status).toBe(400)
  })

  it("rejects a path-shaped vendor", async () => {
    const { req, url } = get("/api/history/sessions?worktreePath=/tmp&vendor=../claude")
    const res = await handleHistoryRequest(req, url)
    expect(res?.status).toBe(400)
  })

  it("rejects traversal in sessionId", async () => {
    for (const bad of ["../../etc/passwd", "a/b", "a\\b", ""]) {
      const { req, url } = get(`/api/history/messages?vendor=claude&sessionId=${encodeURIComponent(bad)}`)
      const res = await handleHistoryRequest(req, url)
      expect(res?.status).toBe(400)
    }
  })

  it("returns an empty session list for a worktree with no transcripts", async () => {
    const { req, url } = get("/api/history/sessions?worktreePath=/nonexistent-kobe-test-dir&vendor=claude")
    const res = await handleHistoryRequest(req, url)
    expect(res?.status).toBe(200)
    const json = (await res?.json()) as { sessions: string[]; latestMtime: number }
    expect(json.sessions).toEqual([])
    expect(json.latestMtime).toBe(0)
  })
})
