import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pluginConfigDir } from "@sma1lboy/kobe-daemon/plugins/plugin-paths"
import { savePluginRegistry } from "@sma1lboy/kobe-daemon/plugins/registry"
import { findFileHandler, readPluginSettings, writePluginSettings } from "@sma1lboy/kobe-daemon/plugins/settings-env"
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

describe("plugin settings env store", () => {
  it("round-trips values, preserves unrelated lines, removes on empty", () => {
    const home = tmp("kobe-senv-")
    mkdirSync(pluginConfigDir("p", home), { recursive: true })
    writeFileSync(join(pluginConfigDir("p", home), ".env"), "# keep me\nOTHER=x\nK_MODE=old\n")
    writePluginSettings("p", { K_MODE: "ascii", K_FPS: "24" }, home)
    expect(readPluginSettings("p", home)).toEqual({ OTHER: "x", K_MODE: "ascii", K_FPS: "24" })
    expect(readFileSync(join(pluginConfigDir("p", home), ".env"), "utf8")).toContain("# keep me")
    writePluginSettings("p", { K_FPS: "" }, home)
    expect(readPluginSettings("p", home)).toEqual({ OTHER: "x", K_MODE: "ascii" })
  })
})

describe("findFileHandler", () => {
  it("routes matching files to the first enabled plugin's action", () => {
    const home = tmp("kobe-fh-home-")
    const root = tmp("kobe-fh-root-")
    writeFileSync(
      join(root, "kobe-plugin.toml"),
      'id = "v"\nname = "V"\nversion = "1.0.0"\nmin_kobe_version = "0.1.0"\n[[actions]]\nid = "open"\ntitle = "O"\ncommand = ["true"]\n[[file_handlers]]\npattern = "\\\\.(mp4|mov)$"\naction = "open"',
    )
    mkdirSync(join(home, ".kobe"), { recursive: true })
    savePluginRegistry(
      { plugins: [{ id: "v", source: { kind: "link" }, root, enabled: true, version: "1", installedAt: 1 }] },
      home,
    )
    expect(findFileHandler("clip.MP4", home)).toEqual({ qualifiedAction: "v.open" })
    expect(findFileHandler("notes.md", home)).toBeNull()
  })
})
