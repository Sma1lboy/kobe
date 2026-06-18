import { afterEach, describe, expect, it, vi } from "vitest"
import { api, ApiError, apiUrl } from "../src/lib/api-client.ts"

afterEach(() => vi.unstubAllGlobals())

describe("apiUrl", () => {
  it("encodes query params with encodeURIComponent semantics", () => {
    expect(apiUrl("/api/notes", { taskId: "t 1/x", skip: undefined })).toBe(
      "/api/notes?taskId=t%201%2Fx",
    )
  })
})

describe("api client", () => {
  it("posts JSON bodies with the standard content type", async () => {
    let seen: { url: string; init?: RequestInit } | null = null
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      seen = { url, init }
      return Promise.resolve(new Response(JSON.stringify({ ok: true })))
    })

    await expect(api.post("/api/rpc", { name: "task.list" })).resolves.toEqual({ ok: true })
    expect(seen?.url).toBe("/api/rpc")
    expect(seen?.init?.method).toBe("POST")
    expect(seen?.init?.headers).toEqual({ "content-type": "application/json" })
    expect(JSON.parse(seen?.init?.body as string)).toEqual({ name: "task.list" })
  })

  it("throws ApiError with JSON error detail and forwarded error name", async () => {
    vi.stubGlobal("fetch", () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "bad transition", name: "IllegalTransitionError" }), { status: 409 }),
      ),
    )

    await expect(api.get("/api/rpc", { label: "rpc task.status" })).rejects.toMatchObject({
      name: "IllegalTransitionError",
      status: 409,
      detail: "bad transition",
    } satisfies Partial<ApiError>)
  })

  it("throws ApiError with text error detail", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("invalid taskId", { status: 400 })))

    await expect(api.get("/api/notes", { label: "load notes" })).rejects.toThrow(/400.*invalid taskId/)
  })

  it("returns the fallback for fail-open reads", async () => {
    vi.stubGlobal("fetch", () => Promise.resolve(new Response("nope", { status: 500 })))

    await expect(api.getOr("/api/engines", { engines: [] }, { label: "load engines" })).resolves.toEqual({
      engines: [],
    })
  })
})
