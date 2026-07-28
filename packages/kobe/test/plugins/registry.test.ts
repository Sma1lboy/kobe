import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pluginRegistryPath } from "@sma1lboy/kobe-daemon/plugins/plugin-paths"
import {
  type PluginRegistryEntry,
  loadPluginRegistry,
  removePluginEntry,
  savePluginRegistry,
  upsertPluginEntry,
} from "@sma1lboy/kobe-daemon/plugins/registry"
import { afterEach, describe, expect, it } from "vitest"

const homes: string[] = []
function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "kobe-plugin-registry-"))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const entry: PluginRegistryEntry = {
  id: "example.a",
  source: { kind: "github", spec: "o/r" },
  root: "/x",
  enabled: true,
  version: "1.0.0",
  installedAt: 1,
}

describe("plugin registry", () => {
  it("round-trips entries through plugins.json", () => {
    const dir = home()
    savePluginRegistry(upsertPluginEntry(loadPluginRegistry(dir), entry), dir)
    expect(loadPluginRegistry(dir).plugins).toEqual([entry])
    expect(readFileSync(pluginRegistryPath(dir), "utf8")).toContain('"example.a"')
  })

  it("upsert replaces an entry with the same id; remove drops it", () => {
    let registry = upsertPluginEntry({ plugins: [] }, entry)
    registry = upsertPluginEntry(registry, { ...entry, version: "2.0.0" })
    expect(registry.plugins).toHaveLength(1)
    expect(registry.plugins[0]?.version).toBe("2.0.0")
    expect(removePluginEntry(registry, "example.a").plugins).toEqual([])
  })

  it("returns an empty registry for a missing, corrupt, or malformed file", () => {
    const dir = home()
    expect(loadPluginRegistry(dir).plugins).toEqual([])
    mkdirSync(dirname(pluginRegistryPath(dir)), { recursive: true })
    writeFileSync(pluginRegistryPath(dir), "{not json")
    expect(loadPluginRegistry(dir).plugins).toEqual([])
    writeFileSync(pluginRegistryPath(dir), JSON.stringify({ plugins: [{ id: 1 }] }))
    expect(loadPluginRegistry(dir).plugins).toEqual([])
  })
})
