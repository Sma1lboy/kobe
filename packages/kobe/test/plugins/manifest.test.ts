import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  currentPluginPlatform,
  parsePluginManifest,
  pluginManifestPath,
  qualifiedActionId,
  readPluginManifest,
  supportsPlatform,
} from "@sma1lboy/kobe-daemon/plugins/manifest"
import { describe, expect, it } from "vitest"

const VALID = `
id = "example.notify"
name = "Notify"
version = "0.1.0"
min_kobe_version = "0.8.0"
description = "Desktop notifications"
platforms = ["macos", "linux"]

[[build]]
command = ["bun", "install"]

[[startup]]
command = ["bun", "restore.ts"]

[[actions]]
id = "test"
title = "Send a test notification"
command = ["bun", "send.ts"]

[[events]]
on = "agent.turn-complete"
command = ["bun", "notify.ts"]
`

describe("parsePluginManifest", () => {
  it("parses a full manifest", () => {
    const { manifest, warnings } = parsePluginManifest(VALID)
    expect(manifest.id).toBe("example.notify")
    expect(manifest.minKobeVersion).toBe("0.8.0")
    expect(manifest.build[0]?.command).toEqual(["bun", "install"])
    expect(manifest.startup).toHaveLength(1)
    expect(manifest.actions[0]).toMatchObject({ id: "test", title: "Send a test notification" })
    expect(manifest.events[0]?.on).toBe("agent.turn-complete")
    expect(warnings).toEqual([])
  })

  it("accepts min_rove_version and gives it precedence over the legacy field", () => {
    const { manifest, warnings } = parsePluginManifest(
      'id = "p"\nname = "P"\nversion = "1.0.0"\nmin_rove_version = "0.9.0"\nmin_kobe_version = "0.8.0"',
    )
    expect(manifest.minKobeVersion).toBe("0.9.0")
    expect(warnings.some((warning) => warning.includes("using `min_rove_version`"))).toBe(true)
  })

  it("requires id/name/version/min_kobe_version", () => {
    expect(() => parsePluginManifest('name = "x"\nversion = "1.0.0"\nmin_kobe_version = "0.1.0"')).toThrow(/`id`/)
    expect(() => parsePluginManifest('id = "x"\nversion = "1.0.0"\nmin_kobe_version = "0.1.0"')).toThrow(/`name`/)
  })

  it("rejects invalid TOML with a labeled error", () => {
    expect(() => parsePluginManifest("id = ")).toThrow(/invalid TOML/)
  })

  it("rejects dots in action ids and duplicate action ids", () => {
    const base = 'id = "p"\nname = "P"\nversion = "1.0.0"\nmin_kobe_version = "0.1.0"\n'
    expect(() => parsePluginManifest(`${base}[[actions]]\nid = "a.b"\ntitle = "T"\ncommand = ["true"]`)).toThrow(
      /may not contain dots/,
    )
    expect(() =>
      parsePluginManifest(
        `${base}[[actions]]\nid = "a"\ntitle = "T"\ncommand = ["true"]\n[[actions]]\nid = "a"\ntitle = "T2"\ncommand = ["true"]`,
      ),
    ).toThrow(/duplicate action id/)
  })

  it("warns on unknown event names and missing platforms", () => {
    const { warnings } = parsePluginManifest(
      'id = "p"\nname = "P"\nversion = "1.0.0"\nmin_kobe_version = "0.1.0"\n[[events]]\non = "no.such"\ncommand = ["true"]',
    )
    expect(warnings.some((w) => w.includes("unknown event"))).toBe(true)
    expect(warnings.some((w) => w.includes("platforms"))).toBe(true)
  })

  it("parses [[panes]] and warns on unsupported placement", () => {
    const base = 'id = "p"\nname = "P"\nversion = "1.0.0"\nmin_kobe_version = "0.1.0"\nplatforms = ["macos"]\n'
    const { manifest, warnings } = parsePluginManifest(
      `${base}[[panes]]\nid = "git"\ntitle = "lazygit"\ncommand = ["lazygit"]\nplacement = "overlay"`,
    )
    expect(manifest.panes[0]).toMatchObject({ id: "git", title: "lazygit", command: ["lazygit"], placement: "split" })
    expect(warnings.some((w) => w.includes("placement"))).toBe(true)
    // Known placements parse silently.
    const tab = parsePluginManifest(`${base}[[panes]]\nid = "b"\ntitle = "B"\ncommand = ["true"]\nplacement = "tab"`)
    expect(tab.manifest.panes[0]?.placement).toBe("tab")
    expect(tab.warnings.some((w) => w.includes("placement"))).toBe(false)
    expect(() => parsePluginManifest(`${base}[[panes]]\nid = "a.b"\ntitle = "T"\ncommand = ["true"]`)).toThrow(
      /may not contain dots/,
    )
  })

  it("rejects a command that is not an argv array", () => {
    expect(() =>
      parsePluginManifest(
        'id = "p"\nname = "P"\nversion = "1.0.0"\nmin_kobe_version = "0.1.0"\n[[startup]]\ncommand = "sh run.sh"',
      ),
    ).toThrow(/argv/)
  })
})

describe("plugin manifest filenames", () => {
  const body = 'id = "p"\nname = "P"\nversion = "1.0.0"\nmin_rove_version = "0.1.0"\nplatforms = ["linux"]'

  it("reads rove-plugin.toml as the canonical spelling", () => {
    const root = mkdtempSync(join(tmpdir(), "rove-manifest-"))
    writeFileSync(join(root, "rove-plugin.toml"), body)
    expect(pluginManifestPath(root)).toBe(join(root, "rove-plugin.toml"))
    expect(readPluginManifest(root).manifest.id).toBe("p")
  })

  it("falls back to kobe-plugin.toml and prefers Rove when both exist", () => {
    const root = mkdtempSync(join(tmpdir(), "rove-manifest-compat-"))
    writeFileSync(join(root, "kobe-plugin.toml"), body.replace('id = "p"', 'id = "legacy"'))
    expect(readPluginManifest(root).manifest.id).toBe("legacy")
    writeFileSync(join(root, "rove-plugin.toml"), body)
    expect(readPluginManifest(root).manifest.id).toBe("p")
  })
})

describe("platform helpers", () => {
  it("maps process.platform tokens", () => {
    expect(currentPluginPlatform("darwin")).toBe("macos")
    expect(currentPluginPlatform("linux")).toBe("linux")
    expect(currentPluginPlatform("win32")).toBe("windows")
    expect(currentPluginPlatform("freebsd" as NodeJS.Platform)).toBeUndefined()
  })

  it("item-level platforms override the manifest list", () => {
    const manifest = { platforms: ["macos" as const] }
    expect(supportsPlatform({}, manifest, "macos")).toBe(true)
    expect(supportsPlatform({}, manifest, "linux")).toBe(false)
    expect(supportsPlatform({ platforms: ["linux"] }, manifest, "linux")).toBe(true)
    // No declaration anywhere → runs everywhere.
    expect(supportsPlatform({}, {}, undefined)).toBe(true)
  })
})

it("qualifies action ids as plugin.action", () => {
  expect(qualifiedActionId("example.notify", "test")).toBe("example.notify.test")
})

describe("settings + file handlers", () => {
  const base = 'id = "p"\nname = "P"\nversion = "1.0.0"\nmin_kobe_version = "0.1.0"\nplatforms = ["macos"]\n'

  it("parses [[settings]] with types, options, defaults", () => {
    const { manifest } = parsePluginManifest(
      `${base}[[settings]]\nkey = "K_MODE"\nlabel = "Mode"\ntype = "enum"\noptions = ["a", "b"]\ndefault = "a"\n[[settings]]\nkey = "K_ON"\nlabel = "On"\ntype = "boolean"`,
    )
    expect(manifest.settings).toEqual([
      { key: "K_MODE", label: "Mode", type: "enum", options: ["a", "b"], default: "a" },
      { key: "K_ON", label: "On", type: "boolean" },
    ])
  })

  it("rejects an enum setting without options and unknown types", () => {
    expect(() => parsePluginManifest(`${base}[[settings]]\nkey = "K"\nlabel = "L"\ntype = "enum"`)).toThrow(/options/)
    expect(() => parsePluginManifest(`${base}[[settings]]\nkey = "K"\nlabel = "L"\ntype = "list"`)).toThrow(/type/)
  })

  it("parses [[file_handlers]] and validates the action + pattern", () => {
    const withAction = `${base}[[actions]]\nid = "open"\ntitle = "O"\ncommand = ["true"]\n`
    const { manifest } = parsePluginManifest(
      `${withAction}[[file_handlers]]\npattern = "\\\\.(mp4|mov)$"\naction = "open"`,
    )
    expect(manifest.fileHandlers).toEqual([{ pattern: "\\.(mp4|mov)$", action: "open" }])
    expect(() => parsePluginManifest(`${withAction}[[file_handlers]]\npattern = "x"\naction = "nope"`)).toThrow(
      /unknown action/,
    )
    expect(() => parsePluginManifest(`${withAction}[[file_handlers]]\npattern = "("\naction = "open"`)).toThrow(
      /valid regex/,
    )
  })
})
