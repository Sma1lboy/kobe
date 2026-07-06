import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchMessages, fetchSessions } from "../src/lib/history.ts"
import { fetchNotes, saveNotes } from "../src/lib/notes.ts"


interface Resp {
  ok: boolean
  status?: number
  json?: unknown
  text?: string
}
let lastReq: { url: string; init?: RequestInit } | null = null

function mockFetch(resp: Resp | ((url: string) => Resp)) {
  lastReq = null
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
    lastReq = { url, init }
    const r = typeof resp === "function" ? resp(url) : resp
    const body = r.text ?? (r.json !== undefined ? JSON.stringify(r.json) : "")
    return Promise.resolve(new Response(body, { status: r.status ?? (r.ok ? 200 : 500) }))
  })
}

afterEach(() => vi.unstubAllGlobals())

describe("notes client", () => {
  it("fetchNotes encodes the taskId and returns markdown ('' when absent)", async () => {
    mockFetch({ ok: true, json: { markdown: "# hi" } })
    expect(await fetchNotes("t 1/x")).toBe("# hi")
    expect(lastReq?.url).toBe("/api/notes?taskId=t%201%2Fx")
    mockFetch({ ok: true, json: {} })
    expect(await fetchNotes("t")).toBe("")
  })

  it("fetchNotes throws with status + detail on failure", async () => {
    mockFetch({ ok: false, status: 400, text: "invalid taskId" })
    await expect(fetchNotes("t")).rejects.toThrow(/400.*invalid taskId/)
  })

  it("saveNotes PUTs a JSON body and resolves on ok", async () => {
    mockFetch({ ok: true })
    await saveNotes("t", "body")
    expect(lastReq?.url).toBe("/api/notes")
    expect(lastReq?.init?.method).toBe("PUT")
    expect(JSON.parse(lastReq?.init?.body as string)).toEqual({
      taskId: "t",
      markdown: "body",
    })
  })

  it("saveNotes throws on failure", async () => {
    mockFetch({ ok: false, status: 500 })
    await expect(saveNotes("t", "x")).rejects.toThrow(/500/)
  })
})

describe("history client", () => {
  it("fetchSessions sends worktreePath + vendor", async () => {
    mockFetch({ ok: true, json: { sessions: ["a"], latestMtime: 5 } })
    const out = await fetchSessions("/wt", "claude")
    expect(out).toEqual({ sessions: ["a"], latestMtime: 5 })
    expect(lastReq?.url).toContain("worktreePath=%2Fwt")
    expect(lastReq?.url).toContain("vendor=claude")
  })

  it("fetchMessages unwraps the messages array", async () => {
    mockFetch({ ok: true, json: { messages: [{ role: "user" }] } })
    const out = await fetchMessages("codex", "sess-1")
    expect(out).toEqual([{ role: "user" }])
    expect(lastReq?.url).toContain("sessionId=sess-1")
  })

  it("throws the JSON error body when present", async () => {
    mockFetch({ ok: false, json: { error: "invalid vendor" } })
    await expect(fetchSessions("/wt", "../bad")).rejects.toThrow("invalid vendor")
  })
})
