import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pluginLogPath } from "@sma1lboy/kobe-daemon/plugins/plugin-paths"
import { savePluginRegistry } from "@sma1lboy/kobe-daemon/plugins/registry"
import { PluginHost } from "@sma1lboy/kobe-daemon/plugins/runtime"
import { afterEach, describe, expect, it } from "vitest"

const dirs: string[] = []
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function waitFor(predicate: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 25))
  }
}

const MANIFEST = `
id = "example.probe"
name = "Probe"
version = "0.1.0"
min_kobe_version = "0.1.0"

[[startup]]
command = ["sh", "-c", "printf %s \\"$KOBE_PLUGIN_EVENT\\" > started.txt"]

[[events]]
on = "task.created"
command = ["sh", "-c", "printf %s \\"$KOBE_PLUGIN_EVENT:$KOBE_PLUGIN_ID:$KOBE_BIN_PATH\\" > event.txt"]
`

function snapshotEvent(ids: string[]) {
  const tasks = ids.map((id) => ({
    id,
    title: id,
    repo: "/r",
    branch: "b",
    worktreePath: "/w",
    kind: "task",
    status: "active",
    archived: false,
    pinned: false,
    createdAt: "x",
    updatedAt: "x",
  }))
  return { channel: "task.snapshot", payload: { tasks } } as never
}

describe("PluginHost", () => {
  it("runs startup hooks and fires event hooks with the env contract", async () => {
    const home = tmp("kobe-plugin-home-")
    const root = tmp("kobe-plugin-root-")
    writeFileSync(join(root, "kobe-plugin.toml"), MANIFEST)
    mkdirSync(join(home, ".kobe"), { recursive: true })
    savePluginRegistry(
      {
        plugins: [
          { id: "example.probe", source: { kind: "link" }, root, enabled: true, version: "0.1.0", installedAt: 1 },
        ],
      },
      home,
    )

    const host = new PluginHost({ homeDir: home, socketPath: "/tmp/fake.sock", binPath: "kobe-test-bin" })
    host.start()
    try {
      await waitFor(() => existsSync(join(root, "started.txt")))
      expect(readFileSync(join(root, "started.txt"), "utf8")).toBe("startup")

      host.handleChannel(snapshotEvent(["a"])) // baseline — must NOT fire
      host.handleChannel(snapshotEvent(["a", "b"]))
      await waitFor(() => existsSync(join(root, "event.txt")))
      expect(readFileSync(join(root, "event.txt"), "utf8")).toBe("task.created:example.probe:kobe-test-bin")

      // The log line lands AFTER each hook process exits — later than the
      // file the hook itself writes — so wait for both entries, not just
      // the log file's existence (CI-speed race, release 0.8.24 #1).
      const logLines = () => {
        try {
          return readFileSync(pluginLogPath("example.probe", home), "utf8").trimEnd().split("\n")
        } catch {
          return []
        }
      }
      await waitFor(() => logLines().length >= 2)
      expect(JSON.parse(logLines()[0] as string)).toMatchObject({ exitCode: 0 })
    } finally {
      host.stop()
    }
  })

  it("skips disabled plugins and unreadable manifests without crashing", async () => {
    const home = tmp("kobe-plugin-home-")
    mkdirSync(join(home, ".kobe"), { recursive: true })
    savePluginRegistry(
      {
        plugins: [
          { id: "off", source: { kind: "link" }, root: "/nope", enabled: false, version: "0", installedAt: 1 },
          { id: "broken", source: { kind: "link" }, root: "/missing", enabled: true, version: "0", installedAt: 1 },
        ],
      },
      home,
    )
    const lines: string[] = []
    const host = new PluginHost({
      homeDir: home,
      socketPath: "/tmp/fake.sock",
      binPath: "kobe",
      log: (l) => lines.push(l),
    })
    host.start()
    host.handleChannel(snapshotEvent(["a"]))
    host.stop()
    expect(lines.some((l) => l.includes("broken"))).toBe(true)
  })
})
