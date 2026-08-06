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
    for (const route of ["messages", "trace", "trace/events"]) {
      for (const bad of ["../../etc/passwd", "a/b", "a\\b", ""]) {
        const { req, url } = get(`/api/history/${route}?vendor=claude&sessionId=${encodeURIComponent(bad)}`)
        const res = await handleHistoryRequest(req, url)
        expect(res?.status).toBe(400)
      }
    }
  })

  it("returns the neutral empty trace for an engine without trace storage", async () => {
    const { req, url } = get("/api/history/trace?vendor=custom-engine&sessionId=session-1")
    const res = await handleHistoryRequest(req, url)
    expect(res?.status).toBe(200)
    await expect(res?.json()).resolves.toEqual({
      trace: { sessionId: "session-1", turns: [] },
    })
  })

  it("streams a full initial trace snapshot for reconnect-safe consumers", async () => {
    const { req, url } = get("/api/history/trace/events?vendor=custom-engine&sessionId=session-1")
    const res = await handleHistoryRequest(req, url)
    expect(res?.status).toBe(200)
    expect(res?.headers.get("content-type")).toBe("text/event-stream")
    const reader = res?.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader?.read()
    await reader?.cancel()
    const text = new TextDecoder().decode(first?.value)
    expect(text).toContain("event: trace")
    expect(text).toContain('data: {"sessionId":"session-1","turns":[]}')
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
