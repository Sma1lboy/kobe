import {
  currentPluginPlatform,
  parsePluginManifest,
  qualifiedActionId,
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
    expect(manifest.panes[0]).toMatchObject({ id: "git", title: "lazygit", command: ["lazygit"] })
    expect(warnings.some((w) => w.includes("placement"))).toBe(true)
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
