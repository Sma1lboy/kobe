import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPaneArgv, listPaneLaunches } from "@sma1lboy/kobe-daemon/plugins/pane-command"
import { savePluginRegistry } from "@sma1lboy/kobe-daemon/plugins/registry"
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

const OPTS = { socketPath: "/tmp/x.sock", binPath: "kobe" }

describe("buildPaneArgv", () => {
  it("wraps the command in sh -lc with the env contract and root expansion", () => {
    const argv = buildPaneArgv(
      "p.id",
      "/plug/root",
      { id: "b", title: "B", placement: "split", command: ["sh", "$ROVE_PLUGIN_ROOT/run.sh", "it's"] },
      OPTS,
    )
    expect(argv.slice(0, 2)).toEqual(["sh", "-lc"])
    const script = argv[2] as string
    expect(script.startsWith("exec env ")).toBe(true)
    for (const frag of [
      "'ROVE_PLUGIN_ID=p.id'",
      "'ROVE_PLUGIN_ROOT=/plug/root'",
      "'ROVE_SOCKET_PATH=/tmp/x.sock'",
      "'ROVE_BIN_PATH=kobe'",
      "'ROVE_PLUGIN_ENTRYPOINT_ID=b'",
      "'KOBE_PLUGIN_ID=p.id'",
      "'KOBE_PLUGIN_ROOT=/plug/root'",
      "'KOBE_SOCKET_PATH=/tmp/x.sock'",
      "'KOBE_BIN_PATH=kobe'",
      "'KOBE_PLUGIN_ENTRYPOINT_ID=b'",
      "'/plug/root/run.sh'",
      // POSIX-quoted single quote survives.
      "'it'\\''s'",
    ]) {
      expect(script).toContain(frag)
    }
  })
})

describe("listPaneLaunches", () => {
  it("lists panes of enabled plugins only, launch-ready", () => {
    const home = tmp("kobe-pane-home-")
    const root = tmp("kobe-pane-root-")
    writeFileSync(
      join(root, "rove-plugin.toml"),
      'id = "p"\nname = "P"\nversion = "1.0.0"\nmin_rove_version = "0.1.0"\n[[panes]]\nid = "git"\ntitle = "lazygit"\ncommand = ["lazygit"]',
    )
    mkdirSync(join(home, ".kobe"), { recursive: true })
    savePluginRegistry(
      {
        plugins: [
          { id: "p", source: { kind: "link" }, root, enabled: true, version: "1.0.0", installedAt: 1 },
          { id: "off", source: { kind: "link" }, root, enabled: false, version: "1.0.0", installedAt: 1 },
        ],
      },
      home,
    )
    const launches = listPaneLaunches({ ...OPTS, homeDir: home })
    expect(launches).toHaveLength(1)
    expect(launches[0]).toMatchObject({ pluginId: "p", paneId: "git", title: "lazygit", placement: "split" })
    expect(launches[0]?.argv[0]).toBe("sh")
  })
})
