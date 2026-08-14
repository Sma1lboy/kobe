import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pluginConfigDir, pluginStateDir } from "@sma1lboy/kobe-daemon/plugins/plugin-paths"
import { loadPluginRegistry, savePluginRegistry } from "@sma1lboy/kobe-daemon/plugins/registry"
import { afterEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ spawnSync: vi.fn() }))

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>()
  return { ...actual, spawnSync: mocks.spawnSync }
})

import { installPlugin, linkPlugin } from "../../src/cli/plugin-install.ts"

const dirs: string[] = []

function pluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rove-plugin-install-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  mocks.spawnSync.mockReset()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("plugin manifest diagnostics", () => {
  it("preserves parser errors instead of reporting an existing manifest as missing", () => {
    const dir = pluginDir()
    writeFileSync(join(dir, "rove-plugin.toml"), 'id = "broken"\n')

    expect(() => linkPlugin(dir)).toThrow(/rove-plugin\.toml: `name` must be a non-empty string/)
  })

  it("names both accepted files when no manifest exists", () => {
    expect(() => linkPlugin(pluginDir())).toThrow(/no rove-plugin\.toml or kobe-plugin\.toml found/)
  })

  it("registers a canonical local plugin and creates its persistent directories", () => {
    const home = pluginDir()
    const root = pluginDir()
    vi.stubEnv("ROVE_HOME_DIR", home)
    writeFileSync(
      join(root, "rove-plugin.toml"),
      'id = "linked.plugin"\nname = "Linked"\nversion = "1.0.0"\nmin_rove_version = "0.1.0"',
    )

    linkPlugin(root)

    expect(loadPluginRegistry(home).plugins).toMatchObject([
      { id: "linked.plugin", root, enabled: true, version: "1.0.0", source: { kind: "link" } },
    ])
    expect(existsSync(pluginConfigDir("linked.plugin", home))).toBe(true)
    expect(existsSync(pluginStateDir("linked.plugin", home))).toBe(true)
  })

  it("rejects incompatible versions and collisions with managed installs", () => {
    const home = pluginDir()
    const root = pluginDir()
    vi.stubEnv("ROVE_HOME_DIR", home)
    writeFileSync(
      join(root, "rove-plugin.toml"),
      'id = "linked.plugin"\nname = "Linked"\nversion = "1.0.0"\nmin_rove_version = "99.0.0"',
    )
    expect(() => linkPlugin(root)).toThrow(/requires Rove >= 99\.0\.0/)

    writeFileSync(
      join(root, "rove-plugin.toml"),
      'id = "linked.plugin"\nname = "Linked"\nversion = "1.0.0"\nmin_rove_version = "0.1.0"',
    )
    savePluginRegistry(
      {
        plugins: [
          {
            id: "linked.plugin",
            source: { kind: "github", spec: "owner/repo" },
            root: "/managed",
            enabled: true,
            version: "0.9.0",
            installedAt: 1,
          },
        ],
      },
      home,
    )
    expect(() => linkPlugin(root)).toThrow(/installed from GitHub; uninstall it before linking/)
  })

  it("installs a canonical manifest from a managed GitHub checkout", async () => {
    const home = pluginDir()
    vi.stubEnv("ROVE_HOME_DIR", home)
    vi.spyOn(console, "log").mockImplementation(() => {})
    mocks.spawnSync.mockImplementation((command: string, args: string[]) => {
      expect(command).toBe("git")
      const checkout = args.at(-1) as string
      writeFileSync(
        join(checkout, "rove-plugin.toml"),
        'id = "managed.plugin"\nname = "Managed"\nversion = "2.0.0"\nmin_rove_version = "0.1.0"',
      )
      return { status: 0 }
    })

    await expect(installPlugin("owner/repo", { yes: true })).resolves.toBe("managed.plugin")

    const [entry] = loadPluginRegistry(home).plugins
    expect(entry).toMatchObject({
      id: "managed.plugin",
      source: { kind: "github", spec: "owner/repo" },
      enabled: true,
      version: "2.0.0",
    })
    expect(existsSync(join(entry?.root ?? "", "rove-plugin.toml"))).toBe(true)
  })
})
