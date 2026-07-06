import {
  createDaemonWebRequestHandler,
  DAEMON_WEB_HEALTH_MARKER,
  DAEMON_WEB_HEALTH_PATH,
} from "@sma1lboy/kobe-daemon/daemon/web-server"
import { describe, expect, it, vi } from "vitest"
import { build, fakeLink, post } from "./route-fakes.ts"


describe("daemon web request handler", () => {
  it("serves the health marker", async () => {
    const { handle } = build()
    const res = await handle(new Request(`http://localhost${DAEMON_WEB_HEALTH_PATH}`))
    expect(await res.text()).toBe(DAEMON_WEB_HEALTH_MARKER)
  })

  it("404s an unknown path when no staticDir is set", async () => {
    const { handle } = build()
    const res = await handle(new Request("http://localhost/nope"))
    expect(res.status).toBe(404)
  })

  describe("cross-origin guard", () => {
    it("rejects a request whose Origin is a non-loopback host", async () => {
      const { handle, link } = build()
      const res = await handle(
        new Request("http://localhost/api/rpc", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://attacker.example" },
          body: JSON.stringify({ name: "task.delete", payload: { taskId: "t1" } }),
        }),
      )
      expect(res.status).toBe(403)
      expect(link.calls).toHaveLength(0)
    })

    it("allows a loopback Origin through", async () => {
      const { handle, link } = build()
      const res = await handle(
        new Request("http://localhost/api/rpc", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://localhost:5173" },
          body: JSON.stringify({ name: "task.list", payload: {} }),
        }),
      )
      expect(res.status).toBe(200)
      expect(link.calls.map((c) => c.name)).toContain("task.list")
    })

    it("allows an Origin-less (non-browser) request through", async () => {
      const { handle } = build()
      const res = await handle(new Request(`http://localhost${DAEMON_WEB_HEALTH_PATH}`))
      expect(await res.text()).toBe(DAEMON_WEB_HEALTH_MARKER)
    })

    it("allows the deliberately-configured LAN host through allowedHost", async () => {
      const link = fakeLink()
      const sseSends = new Set<(type: string, data: unknown) => void>()
      const handle = createDaemonWebRequestHandler({ link, sseSends, allowedHost: "192.168.1.5" })
      const res = await handle(
        new Request("http://192.168.1.5:5173/api/rpc", {
          method: "POST",
          headers: { "content-type": "application/json", origin: "http://192.168.1.5:5173" },
          body: JSON.stringify({ name: "task.list", payload: {} }),
        }),
      )
      expect(res.status).toBe(200)
    })
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

    it("runs the daemon lifetime hook for the SSE stream lifetime", async () => {
      const link = fakeLink()
      const sseSends = new Set<(type: string, data: unknown) => void>()
      const cleanup = vi.fn()
      const onSseOpen = vi.fn(() => cleanup)
      const handle = createDaemonWebRequestHandler({ link, sseSends, onSseOpen })

      const res = await handle(new Request("http://localhost/events"))
      expect(onSseOpen).toHaveBeenCalledTimes(1)

      const reader = res.body?.getReader()
      await reader!.read()
      await reader!.cancel()
      expect(cleanup).toHaveBeenCalledTimes(1)
    })

    it("tears down on request abort even when cancel() never fires (half-open disconnect)", async () => {
      const link = fakeLink()
      const sseSends = new Set<(type: string, data: unknown) => void>()
      const cleanup = vi.fn()
      const handle = createDaemonWebRequestHandler({ link, sseSends, onSseOpen: () => cleanup })

      const ac = new AbortController()
      const res = await handle(new Request("http://localhost/events", { signal: ac.signal }))
      const reader = res.body?.getReader()
      await reader!.read()
      expect(sseSends.size).toBe(1)

      ac.abort()
      expect(cleanup).toHaveBeenCalledTimes(1)
      expect(sseSends.size).toBe(0)

      await reader!.cancel()
      expect(cleanup).toHaveBeenCalledTimes(1)
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

  describe("/api/cli-invocation", () => {
    it("returns the environment-correct kobe api invocation", async () => {
      const { handle } = build()
      const res = await handle(new Request("http://localhost/api/cli-invocation"))
      expect(res.status).toBe(200)
      const body = (await res.json()) as { api: string }
      expect(body.api).toContain(" api")
    })
  })

  describe("/api/issues", () => {
    it("proxies issue reads to the daemon", async () => {
      const { handle, link } = build({
        onRequest: (name) => (name === "issue.list" ? { repoRoot: "/repo", exists: false, nextId: 1, issues: [] } : {}),
      })
      const res = await handle(new Request("http://localhost/api/issues?repoRoot=%2Frepo"))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ repoRoot: "/repo", exists: false, nextId: 1, issues: [] })
      expect(link.calls).toEqual([{ name: "issue.list", payload: { repoRoot: "/repo" } }])
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

})
