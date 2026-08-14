import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { linkPlugin } from "../../src/cli/plugin-install.ts"

const dirs: string[] = []

function pluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rove-plugin-install-"))
  dirs.push(dir)
  return dir
}

afterEach(() => {
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
})
