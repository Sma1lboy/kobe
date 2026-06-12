import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { describe, expect, it, vi } from "vitest"
import {
  type BridgeLink,
  createRequestHandler,
  WEB_HEALTH_MARKER,
  WEB_HEALTH_PATH,
} from "../server/bridge.ts"

/**
 * Integration coverage for the bridge's HTTP route table, driven through
 * createRequestHandler against a FAKE link (no socket, no daemon, no tmux).
 * This is the gate for the whole browser-facing surface: the RPC allowlist +
 * teardown hook, the SSE snapshot/fan-out, the engine/theme routes, and the
 * static/404 fallthrough.
 */

interface FakeOpts {
  snapshot?: unknown
  onRequest?: (name: string, payload: unknown) => unknown
}

function fakeLink(opts: FakeOpts = {}): BridgeLink & { calls: Array<{ name: string; payload: unknown }> } {
  const calls: Array<{ name: string; payload: unknown }> = []
  return {
    calls,
    async request<T>(name: DaemonRequestName, payload?: unknown): Promise<T> {
      calls.push({ name, payload })
      return (opts.onRequest?.(name, payload) ?? {}) as T
    },
    snapshot() {
      return opts.snapshot ?? { tasks: [], connected: true }
    },
  }
}

function build(opts: FakeOpts = {}) {
  const link = fakeLink(opts)
  const tearDown = vi.fn()
  const sseSends = new Set<(type: string, data: unknown) => void>()
  const handle = createRequestHandler({ link, sseSends, tearDownSession: tearDown })
  return { handle, link, tearDown, sseSends }
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("bridge request handler", () => {
  it("serves the health marker", async () => {
    const { handle } = build()
    const res = await handle(new Request(`http://localhost${WEB_HEALTH_PATH}`))
    expect(await res.text()).toBe(WEB_HEALTH_MARKER)
  })

  it("404s an unknown path when no staticDir is set", async () => {
    const { handle } = build()
    const res = await handle(new Request("http://localhost/nope"))
    expect(res.status).toBe(404)
  })

  describe("/api/rpc", () => {
    it("forwards an allowlisted verb and returns its result", async () => {
      const { handle, link } = build({
        onRequest: (name) => (name === "task.list" ? { tasks: [{ id: "t1" }] } : {}),
      })
      const res = await handle(post("/api/rpc", { name: "task.list" }))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ result: { tasks: [{ id: "t1" }] } })
      expect(link.calls).toEqual([{ name: "task.list", payload: undefined }])
    })

    it("rejects a non-allowlisted verb with 403 and never hits the link", async () => {
      const { handle, link } = build()
      const res = await handle(post("/api/rpc", { name: "daemon.stop" }))
      expect(res.status).toBe(403)
      expect(link.calls).toHaveLength(0)
    })

    it("rejects hello/subscribe (connection-scoped) with 403", async () => {
      const { handle } = build()
      for (const name of ["hello", "subscribe"]) {
        const res = await handle(post("/api/rpc", { name }))
        expect(res.status).toBe(403)
      }
    })

    it("400s a missing rpc name", async () => {
      const { handle } = build()
      const res = await handle(post("/api/rpc", {}))
      expect(res.status).toBe(400)
    })

    it("500s when the link throws, surfacing the message", async () => {
      const { handle } = build({
        onRequest: () => {
          throw new Error("daemon exploded")
        },
      })
      const res = await handle(post("/api/rpc", { name: "task.list" }))
      expect(res.status).toBe(500)
      expect((await res.json()).error).toContain("daemon exploded")
    })

    it("forwards a NAMED daemon error so the SPA can branch on it", async () => {
      const { handle } = build({
        onRequest: () => {
          const err = new Error("illegal transition for task t1")
          err.name = "IllegalTransitionError"
          throw err
        },
      })
      const res = await handle(post("/api/rpc", { name: "task.status" }))
      expect(res.status).toBe(500)
      const body = await res.json()
      expect(body.name).toBe("IllegalTransitionError")
      expect(body.error).toContain("illegal transition")
    })

    it("omits the name field for a plain anonymous Error", async () => {
      const { handle } = build({
        onRequest: () => {
          throw new Error("boom")
        },
      })
      const res = await handle(post("/api/rpc", { name: "task.list" }))
      expect(await res.json()).not.toHaveProperty("name")
    })

    it("tears down the session after a delete", async () => {
      const { handle, tearDown } = build()
      await handle(post("/api/rpc", { name: "task.delete", payload: { taskId: "t9" } }))
      expect(tearDown).toHaveBeenCalledWith("t9")
    })

    it("tears down the session when archiving", async () => {
      const { handle, tearDown } = build()
      await handle(post("/api/rpc", { name: "task.archive", payload: { taskId: "t9", archived: true } }))
      expect(tearDown).toHaveBeenCalledWith("t9")
    })

    it("does NOT tear down on un-archive (archived: false)", async () => {
      const { handle, tearDown } = build()
      await handle(post("/api/rpc", { name: "task.archive", payload: { taskId: "t9", archived: false } }))
      expect(tearDown).not.toHaveBeenCalled()
    })

    it("does NOT tear down on a plain mutation like rename", async () => {
      const { handle, tearDown } = build()
      await handle(post("/api/rpc", { name: "task.rename", payload: { taskId: "t9", title: "x" } }))
      expect(tearDown).not.toHaveBeenCalled()
    })
  })

  describe("/events (SSE)", () => {
    it("opens a stream, emits the snapshot, and registers a sink", async () => {
      const snapshot = { tasks: [{ id: "t1" }], connected: true }
      const { handle, sseSends } = build({ snapshot })
      const res = await handle(new Request("http://localhost/events"))
      expect(res.headers.get("content-type")).toContain("text/event-stream")
      expect(sseSends.size).toBe(1)
      const reader = res.body?.getReader()
      const { value } = await reader!.read()
      const text = new TextDecoder().decode(value)
      expect(text).toContain("event: snapshot")
      expect(text).toContain(`"id":"t1"`)
      await reader!.cancel()
    })
  })

  describe("/api/engines", () => {
    it("returns at least the claude entry", async () => {
      const { handle } = build()
      const res = await handle(new Request("http://localhost/api/engines"))
      expect(res.status).toBe(200)
      const json = (await res.json()) as { engines: Array<{ id: string; label: string }> }
      expect(json.engines.length).toBeGreaterThan(0)
      expect(json.engines.some((e) => e.id === "claude")).toBe(true)
    })
  })

  describe("/api/themes", () => {
    it("returns the bundled theme palettes", async () => {
      const { handle } = build()
      const res = await handle(new Request("http://localhost/api/themes"))
      expect(res.status).toBe(200)
      const json = (await res.json()) as { themes: Record<string, Record<string, string>> }
      expect(Object.keys(json.themes)).toContain("claude")
      expect(json.themes.claude.bg).toMatch(/^#/)
    })
  })

  describe("/api/history guards", () => {
    it("400s a relative worktreePath", async () => {
      const { handle } = build()
      const res = await handle(
        new Request("http://localhost/api/history/sessions?worktreePath=../x&vendor=claude"),
      )
      expect(res?.status).toBe(400)
    })
  })

  // The session/spec routes build a PTY launch (tmux session, shell command),
  // so only the input guard is unit-safe here — the happy path would spawn real
  // tmux. These cases return BEFORE any link/tmux work.
  describe("/api/session & spec guards", () => {
    it("400s POST /api/session with no taskId (never touches the link)", async () => {
      const { handle, link } = build()
      const res = await handle(post("/api/session", {}))
      expect(res.status).toBe(400)
      expect(link.calls).toHaveLength(0)
    })

    it("400s GET /api/engine-spec with no taskId", async () => {
      const { handle, link } = build()
      const res = await handle(new Request("http://localhost/api/engine-spec"))
      expect(res.status).toBe(400)
      expect(link.calls).toHaveLength(0)
    })

    it("400s GET /api/terminal-spec with no taskId", async () => {
      const { handle, link } = build()
      const res = await handle(new Request("http://localhost/api/terminal-spec"))
      expect(res.status).toBe(400)
      expect(link.calls).toHaveLength(0)
    })

    it("500s POST /api/session on an invalid JSON body", async () => {
      const { handle } = build()
      const res = await handle(
        new Request("http://localhost/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{not json",
        }),
      )
      expect(res.status).toBe(500)
    })
  })

  // Note: the static fallthrough uses `Bun.file`, which only exists under the
  // Bun runtime — the live `kobe web` server. It's not exercised here because
  // vitest runs under node; the route ordering (404 when no staticDir) is
  // covered above.
})
