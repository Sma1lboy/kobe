import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { patchStateFile } from "../../kobe/src/state/store.ts"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { build } from "./route-fakes.ts"

/**
 * The state.json-backed web routes (quick-prompts, saved projects, shared
 * settings + custom-engine management), split from bridge-routes.test.ts
 * (file-size cap). Runs against a throwaway KOBE_HOME_DIR.
 */

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
