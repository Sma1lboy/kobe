import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pluginLogPath } from "@sma1lboy/kobe-daemon/plugins/plugin-paths"
import { loadPluginRegistry } from "@sma1lboy/kobe-daemon/plugins/registry"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runPluginSubcommand } from "../../src/cli/plugin-cmd.ts"

const dirs: string[] = []

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("plugin command workflow", () => {
  it("links, inspects, toggles, and unlinks a canonical Rove plugin", async () => {
    const home = tempDir("rove-plugin-cmd-home-")
    const root = tempDir("rove-plugin-cmd-root-")
    vi.stubEnv("ROVE_HOME_DIR", home)
    writeFileSync(
      join(root, "rove-plugin.toml"),
      [
        'id = "example.workflow"',
        'name = "Workflow"',
        'version = "1.2.3"',
        'min_rove_version = "0.1.0"',
        "[[actions]]",
        'id = "run"',
        'title = "Run workflow"',
        'command = ["true"]',
      ].join("\n"),
    )
    const output: string[] = []
    vi.spyOn(console, "log").mockImplementation((...args) => output.push(args.map(String).join(" ")))

    await runPluginSubcommand(["link", root])
    await runPluginSubcommand(["list"])
    await runPluginSubcommand(["disable", "example.workflow"])
    expect(loadPluginRegistry(home).plugins[0]?.enabled).toBe(false)
    await runPluginSubcommand(["enable", "example.workflow"])
    await runPluginSubcommand(["action", "list", "--plugin", "example.workflow"])
    await runPluginSubcommand(["config-dir", "example.workflow"])
    await runPluginSubcommand(["log", "example.workflow"])
    writeFileSync(pluginLogPath("example.workflow", home), '{"run":1}\n{"run":2}\n')
    await runPluginSubcommand(["log", "example.workflow", "-n", "1"])

    expect(output.join("\n")).toContain("linked example.workflow v1.2.3")
    expect(output.join("\n")).toContain("example.workflow.run  Run workflow")
    expect(output.join("\n")).toContain(join(home, ".kobe", "plugins", "example.workflow", "config"))
    expect(output.join("\n")).toContain("(no runs logged yet)")
    expect(output.join("\n")).toContain('{"run":2}')
    expect(existsSync(join(home, ".kobe", "plugins", "example.workflow", "state"))).toBe(true)

    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never)
    await runPluginSubcommand(["action", "invoke", "example.workflow.run", "extra"])
    expect(exit).toHaveBeenCalledWith(0)
    exit.mockRestore()

    await runPluginSubcommand(["unlink", "example.workflow"])
    expect(loadPluginRegistry(home).plugins).toEqual([])
    expect(existsSync(root)).toBe(true)
    await runPluginSubcommand(["list"])

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    await runPluginSubcommand(["--help"])
    expect(stdout.mock.calls.map((call) => String(call[0])).join("")).toContain("GitHub topic rove-plugin")
  })
})
