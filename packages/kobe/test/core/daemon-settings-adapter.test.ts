import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { daemonSettingsPatch, daemonSettingsSnapshot } from "../../src/core/daemon-settings-adapter.ts"

describe("daemon settings adapter", () => {
  let home: string
  let previousHome: string | undefined

  beforeAll(async () => {
    previousHome = process.env.KOBE_HOME_DIR
    home = await mkdtemp(join(tmpdir(), "kobe-daemon-settings-"))
    process.env.KOBE_HOME_DIR = home
  })

  afterAll(async () => {
    if (previousHome === undefined) process.env.KOBE_HOME_DIR = undefined
    else process.env.KOBE_HOME_DIR = previousHome
    await rm(home, { recursive: true, force: true })
  })

  it("round-trips shared preferences and custom engines", async () => {
    const initial = (await daemonSettingsSnapshot().json()) as {
      activeTheme: string
      engines: Array<{ id: string; isBuiltin: boolean }>
    }
    expect(initial.activeTheme).toBe("claude")
    expect(initial.engines).toContainEqual(expect.objectContaining({ id: "claude", isBuiltin: true }))

    const patched = await daemonSettingsPatch(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({
          activeTheme: "matrix",
          transparentBackground: true,
          focusAccent: "info",
          notificationsToast: false,
          editorKind: "custom",
          editorCustomCommand: "code -w {file}",
          remoteProjects: true,
          archivedHistoryPreview: true,
          autoStatus: true,
          dispatcher: true,
          addEngine: { id: "my-engine", label: "My Engine", command: "my-engine --stdio" },
        }),
      }),
    )
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({
      activeTheme: "matrix",
      transparentBackground: true,
      editorKind: "custom",
    })

    const duplicate = await daemonSettingsPatch(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ addEngine: { id: "my-engine" } }),
      }),
    )
    expect(duplicate.status).toBe(400)

    const removed = await daemonSettingsPatch(
      new Request("http://localhost/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ removeEngine: "my-engine" }),
      }),
    )
    expect((await removed.json()).engines).not.toContainEqual(expect.objectContaining({ id: "my-engine" }))

    const malformed = await daemonSettingsPatch(
      new Request("http://localhost/api/settings", { method: "PATCH", body: "not-json" }),
    )
    expect(malformed.status).toBe(400)
  })
})
