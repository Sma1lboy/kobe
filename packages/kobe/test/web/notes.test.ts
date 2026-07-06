import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { handleNotesRequest } from "../../src/web/notes.ts"

function get(path: string): { req: Request; url: URL } {
  const url = new URL(`http://localhost${path}`)
  return { req: new Request(url), url }
}

function put(path: string, body: unknown): { req: Request; url: URL } {
  const url = new URL(`http://localhost${path}`)
  const req = new Request(url, {
    method: "PUT",
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  return { req, url }
}

const BAD_IDS = ["../../etc/passwd", "a/b", "a\\b", "..", "", "a.b", "a b"]

describe("handleNotesRequest — routing", () => {
  it("falls through (null) for a non-notes path", async () => {
    const { req, url } = get("/api/history/sessions?worktreePath=/tmp")
    expect(await handleNotesRequest(req, url)).toBeNull()
  })

  it("rejects an unsupported method with 405", async () => {
    const url = new URL("http://localhost/api/notes?taskId=abc")
    const res = await handleNotesRequest(new Request(url, { method: "DELETE" }), url)
    expect(res?.status).toBe(405)
  })
})

describe("handleNotesRequest — GET taskId guard", () => {
  it("rejects every traversal-shaped taskId with 400 (no fs access)", async () => {
    for (const bad of BAD_IDS) {
      const { req, url } = get(`/api/notes?taskId=${encodeURIComponent(bad)}`)
      const res = await handleNotesRequest(req, url)
      expect(res?.status, `taskId=${JSON.stringify(bad)}`).toBe(400)
    }
  })

  it("rejects a missing taskId with 400", async () => {
    const { req, url } = get("/api/notes")
    const res = await handleNotesRequest(req, url)
    expect(res?.status).toBe(400)
  })
})

describe("handleNotesRequest — PUT body guard", () => {
  it("rejects a traversal taskId with 400", async () => {
    const { req, url } = put("/api/notes", { taskId: "../x", markdown: "hi" })
    const res = await handleNotesRequest(req, url)
    expect(res?.status).toBe(400)
  })

  it("rejects a non-string markdown with 400", async () => {
    const { req, url } = put("/api/notes", { taskId: "good", markdown: 42 })
    const res = await handleNotesRequest(req, url)
    expect(res?.status).toBe(400)
  })

  it("rejects an invalid JSON body with 400", async () => {
    const { req, url } = put("/api/notes", "{not json")
    const res = await handleNotesRequest(req, url)
    expect(res?.status).toBe(400)
  })
})

describe("handleNotesRequest — happy path (hermetic temp home)", () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-notes-test-"))
    vi.stubEnv("KOBE_HOME_DIR", dir)
  })

  afterAll(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  it("round-trips a valid taskId: PUT then GET returns the saved markdown", async () => {
    const w = put("/api/notes", { taskId: "task_01", markdown: "# hi\n" })
    const wrote = await handleNotesRequest(w.req, w.url)
    expect(wrote?.status).toBe(200)

    const { req, url } = get("/api/notes?taskId=task_01")
    const res = await handleNotesRequest(req, url)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ markdown: "# hi\n" })
  })

  it("returns empty markdown for a valid-but-absent taskId", async () => {
    const { req, url } = get("/api/notes?taskId=never_written")
    const res = await handleNotesRequest(req, url)
    expect(res?.status).toBe(200)
    expect(await res?.json()).toEqual({ markdown: "" })
  })
})
