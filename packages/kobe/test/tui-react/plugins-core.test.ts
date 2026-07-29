/**
 * Settings → Plugins view model (settings-dialog/plugins-core.ts).
 *
 * The section renders whatever these pure builders say, so the parts that
 * can silently go wrong are pinned here: a run log whose last line is
 * half-written (the daemon appends while we read), a manifest that no
 * longer parses, and the counts/source label shown per row.
 */

import type { PluginRegistryEntry } from "@sma1lboy/kobe-daemon/plugins/registry"
import { describe, expect, it } from "vitest"
import { formatAgo, parseLastRun, pluginRowView } from "../../src/tui-react/component/settings-dialog/plugins-core.ts"

const NOW = Date.parse("2026-07-27T12:00:00.000Z")

const githubEntry: PluginRegistryEntry = {
  id: "example.notify",
  source: { kind: "github", spec: "acme/kobe-notify" },
  root: "/home/u/.kobe/plugins/example.notify/checkout",
  enabled: true,
  version: "0.1.0",
  installedAt: NOW,
}

const MANIFEST = `
id = "example.notify"
name = "Notify"
version = "0.1.0"
min_kobe_version = "0.8.23"

[[actions]]
id = "test"
title = "Send a test notification"
command = ["sh", "notify.sh", "test"]

[[events]]
on = "agent.turn-complete"
command = ["sh", "notify.sh"]

[[events]]
on = "task.created"
command = ["sh", "notify.sh"]

[[settings]]
key = "KOBE_NOTIFY_SOUND"
label = "Sound"
type = "enum"
options = ["ping", "glass"]
default = "ping"
`

const runLine = (record: Record<string, unknown>) => `${JSON.stringify(record)}\n`

describe("parseLastRun", () => {
  it("returns the newest record, with ok only for a clean exit", () => {
    const text =
      runLine({ at: NOW - 1000, kind: "startup", label: "startup", exitCode: 0, durationMs: 5 }) +
      runLine({ at: NOW - 100, kind: "event", label: "agent.turn-complete", exitCode: 2, durationMs: 7 })
    expect(parseLastRun(text)).toEqual({ at: NOW - 100, label: "agent.turn-complete", exitCode: 2, ok: false })
  })

  it("marks a spawn failure as not-ok and keeps the message", () => {
    const run = parseLastRun(runLine({ at: NOW, kind: "event", label: "task.created", spawnError: "ENOENT sh" }))
    expect(run).toMatchObject({ ok: false, exitCode: null, spawnError: "ENOENT sh" })
  })

  it("skips a half-written trailing line and falls back to the last valid one", () => {
    const text = `${runLine({ at: NOW - 500, kind: "startup", label: "startup", exitCode: 0 })}{"at":17`
    expect(parseLastRun(text)?.label).toBe("startup")
  })

  it("is null for a missing or empty log", () => {
    expect(parseLastRun(null)).toBeNull()
    expect(parseLastRun("\n\n")).toBeNull()
  })
})

describe("pluginRowView", () => {
  it("counts what the manifest declares and labels a GitHub source", () => {
    const row = pluginRowView(githubEntry, MANIFEST, null)
    expect(row).toMatchObject({
      id: "example.notify",
      version: "0.1.0",
      enabled: true,
      linked: false,
      source: "acme/kobe-notify",
      declares: { actions: 1, events: 2, panes: 0 },
      lastRun: null,
    })
  })

  it("reports null declares when the manifest is missing or unparsable", () => {
    expect(pluginRowView(githubEntry, null, null).declares).toBeNull()
    expect(pluginRowView(githubEntry, "id = 42", null).declares).toBeNull()
  })

  it("joins declared settings with their stored values, and has none without a manifest", () => {
    const stored = pluginRowView(githubEntry, MANIFEST, null, { KOBE_NOTIFY_SOUND: "glass" })
    expect(stored.settings).toEqual([
      {
        key: "KOBE_NOTIFY_SOUND",
        label: "Sound",
        type: "enum",
        options: ["ping", "glass"],
        defaultValue: "ping",
        value: "glass",
        defaulted: false,
      },
    ])
    expect(pluginRowView(githubEntry, MANIFEST, null).settings[0]).toMatchObject({ value: "ping", defaulted: true })
    expect(pluginRowView(githubEntry, null, null).settings).toEqual([])
  })

  it("shows a linked plugin's working directory as its source", () => {
    const linked: PluginRegistryEntry = {
      ...githubEntry,
      source: { kind: "link" },
      root: "/work/my-plugin",
      enabled: false,
    }
    const row = pluginRowView(linked, MANIFEST, null)
    expect(row.linked).toBe(true)
    expect(row.source).toBe("/work/my-plugin")
    expect(row.enabled).toBe(false)
  })
})

describe("formatAgo", () => {
  it("steps through seconds, minutes, hours, and days", () => {
    expect(formatAgo(3_000)).toBe("3s")
    expect(formatAgo(5 * 60_000)).toBe("5m")
    expect(formatAgo(3 * 3_600_000)).toBe("3h")
    expect(formatAgo(2 * 86_400_000)).toBe("2d")
  })

  it("clamps a clock-skewed future stamp to 0s", () => {
    expect(formatAgo(-5000)).toBe("0s")
  })
})
