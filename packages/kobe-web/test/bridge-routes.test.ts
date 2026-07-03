import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DaemonRequestName } from "@sma1lboy/kobe-daemon/daemon/protocol"
import {
  createDaemonWebRequestHandler,
  DAEMON_WEB_HEALTH_MARKER,
  DAEMON_WEB_HEALTH_PATH,
  type DaemonWebLink,
} from "@sma1lboy/kobe-daemon/daemon/web-server"
import { patchStateFile } from "../../kobe/src/state/store.ts"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

/**
 * Integration coverage for the daemon-hosted web HTTP route table, driven
 * through createDaemonWebRequestHandler against a FAKE link (no tmux).
 * This is the gate for the whole browser-facing surface: the RPC allowlist +
 * teardown hook, the SSE snapshot/fan-out, the engine/theme routes, and the
 * static/404 fallthrough.
 */

interface FakeOpts {
  snapshot?: unknown
  onRequest?: (name: string, payload: unknown) => unknown
}

function fakeLink(opts: FakeOpts = {}): DaemonWebLink & { calls: Array<{ name: string; payload: unknown }> } {
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
  const handle = createDaemonWebRequestHandler({ link, sseSends, tearDownSession: tearDown })
  return { handle, link, tearDown, sseSends }
}

function post(path: string, body: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

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
      // The dangerous RPC never reached the daemon link.
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

      // cancel() arriving later must not double-run the unregister path.
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

describe("/api/quick-prompts", () => {
  // These hit the real state.json helpers, so point KOBE_HOME_DIR at a
  // throwaway dir for the duration (the other suites never touch it).
  let home: string
  let prevHome: string | undefined

  beforeAll(async () => {
    prevHome = process.env.KOBE_HOME_DIR
    home = await mkdtemp(join(tmpdir(), "kobe-qp-"))
    process.env.KOBE_HOME_DIR = home
  })

  afterAll(async () => {
    if (prevHome === undefined) delete process.env.KOBE_HOME_DIR
    else process.env.KOBE_HOME_DIR = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it("rounds templates through state.json: empty → PUT → GET", async () => {
    const { handle } = build()
    const empty = await (
      await handle(new Request("http://localhost/api/quick-prompts"))
    ).json()
    expect(empty).toEqual({ review: null, pr: null })

    const put = await handle(
      new Request("http://localhost/api/quick-prompts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ review: "/review --deep", pr: "open a DRAFT pr" }),
      }),
    )
    expect(await put.json()).toEqual({ review: "/review --deep", pr: "open a DRAFT pr" })

    const got = await (
      await handle(new Request("http://localhost/api/quick-prompts"))
    ).json()
    expect(got).toEqual({ review: "/review --deep", pr: "open a DRAFT pr" })
  })

  it("returns saved project repos from state.json", async () => {
    patchStateFile({ savedRepos: ["/repo/kobe", "/repo/web"] })
    const { handle } = build()
    const res = await handle(new Request("http://localhost/api/projects"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      projects: ["/repo/kobe", "/repo/web"],
    })
  })

  it("400s malformed JSON and ignores non-string fields", async () => {
    const { handle } = build()
    const bad = await handle(
      new Request("http://localhost/api/quick-prompts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
    )
    expect(bad.status).toBe(400)

    const partial = await handle(
      new Request("http://localhost/api/quick-prompts", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ review: 42 }),
      }),
    )
    expect(partial.status).toBe(200)
  })

  it("rounds shared web/TUI settings through state.json", async () => {
    const { handle } = build()
    const empty = (await (
      await handle(new Request("http://localhost/api/settings"))
    ).json()) as {
      activeTheme: string
      transparentBackground: boolean
      focusAccent: string
      settingsSurface: string
      editorKind: string
      remoteProjects: boolean
      archivedHistoryPreview: boolean
      autoStatus: boolean
      dispatcher: boolean
      engines: Array<{ id: string; isBuiltin: boolean; isDefault: boolean }>
    }
    expect(empty.activeTheme).toBe("claude")
    expect(empty.transparentBackground).toBe(false)
    expect(empty.focusAccent).toBe("primary")
    expect(empty.settingsSurface).toBe("chattab")
    expect(empty.editorKind).toBe("auto")
    expect(empty.archivedHistoryPreview).toBe(false)
    expect(empty.engines.some((engine) => engine.id === "claude" && engine.isBuiltin)).toBe(true)

    const patched = (await (
      await handle(
        new Request("http://localhost/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            activeTheme: "matrix",
            transparentBackground: true,
            focusAccent: "info",
            notificationsToast: false,
            settingsSurface: "taskpanel",
            editorKind: "custom",
            editorCustomCommand: "code -w {file}",
            remoteProjects: true,
            archivedHistoryPreview: true,
            autoStatus: true,
            dispatcher: true,
            defaultEngine: "codex",
          }),
        }),
      )
    ).json()) as typeof empty & {
      notificationsToast: boolean
      editorCustomCommand: string
      defaultEngine: string
    }
    expect(patched.activeTheme).toBe("matrix")
    expect(patched.transparentBackground).toBe(true)
    expect(patched.focusAccent).toBe("info")
    expect(patched.notificationsToast).toBe(false)
    expect(patched.settingsSurface).toBe("taskpanel")
    expect(patched.editorKind).toBe("custom")
    expect(patched.editorCustomCommand).toBe("code -w {file}")
    expect(patched.remoteProjects).toBe(true)
    expect(patched.archivedHistoryPreview).toBe(true)
    expect(patched.autoStatus).toBe(true)
    expect(patched.dispatcher).toBe(true)
    expect(patched.defaultEngine).toBe("codex")
  })

  it("adds, edits, defaults, and removes a custom engine", async () => {
    const { handle } = build()
    const added = (await (
      await handle(
        new Request("http://localhost/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            addEngine: { id: "aider", command: "aider --model sonnet", label: "Aider" },
            defaultEngine: "aider",
          }),
        }),
      )
    ).json()) as {
      defaultEngine: string
      engines: Array<{ id: string; label: string; command: string; isCustom: boolean; isDefault: boolean }>
    }
    expect(added.defaultEngine).toBe("aider")
    expect(added.engines).toContainEqual(
      expect.objectContaining({
        id: "aider",
        label: "Aider",
        command: "aider --model sonnet",
        isCustom: true,
        isDefault: true,
      }),
    )

    const edited = (await (
      await handle(
        new Request("http://localhost/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            engineUpdates: [{ id: "aider", command: "aider --yes", label: "Aider CLI" }],
          }),
        }),
      )
    ).json()) as typeof added
    expect(edited.engines).toContainEqual(
      expect.objectContaining({ id: "aider", label: "Aider CLI", command: "aider --yes" }),
    )

    const removed = (await (
      await handle(
        new Request("http://localhost/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ removeEngine: "aider" }),
        }),
      )
    ).json()) as typeof added
    expect(removed.defaultEngine).toBe("claude")
    expect(removed.engines.some((engine) => engine.id === "aider")).toBe(false)
  })

  it("rejects duplicate or invalid custom engine ids", async () => {
    const { handle } = build()
    const bad = await handle(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ addEngine: { id: "Claude", command: "x" } }),
      }),
    )
    expect(bad.status).toBe(400)
  })

  it("keeps built-in engine display names separate from launch commands", async () => {
    const { handle } = build()
    const patched = (await (
      await handle(
        new Request("http://localhost/api/settings", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            engineUpdates: [
              {
                id: "codex",
                command: "codex --dangerously-bypass-approvals-and-sandbox",
                label: "Codex",
              },
            ],
          }),
        }),
      )
    ).json()) as {
      engines: Array<{ id: string; label: string; command: string }>
    }
    expect(patched.engines).toContainEqual(
      expect.objectContaining({
        id: "codex",
        label: "Codex",
        command: "codex --dangerously-bypass-approvals-and-sandbox",
      }),
    )
  })
})
