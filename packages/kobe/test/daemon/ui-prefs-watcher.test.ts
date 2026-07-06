import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type ChannelEvent, DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import type { UiPrefsPayload } from "@sma1lboy/kobe-daemon/daemon/protocol"
import {
  defaultUiPrefsStatePath,
  readUiPrefsFromStateFile,
  startUiPrefsWatcher,
} from "@sma1lboy/kobe-daemon/daemon/ui-prefs-watcher"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { patchStateFile } from "../../src/state/store.ts"

let tmpHome: string
let statePath: string
let savedHomeDir: string | undefined
let bus: DaemonEventBus
let events: UiPrefsPayload[]
let stop: (() => void) | null

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-uiprefs-"))
  savedHomeDir = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
  statePath = defaultUiPrefsStatePath(tmpHome)
  bus = new DaemonEventBus()
  events = []
  bus.onPublish((event: ChannelEvent) => {
    if (event.channel === "ui-prefs") events.push(event.payload as UiPrefsPayload)
  })
  stop = null
})

afterEach(() => {
  stop?.()
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset when the var was unset before the test (assigning undefined leaves it as the string "undefined"). Same pattern as test/state/store.test.ts.
  if (savedHomeDir === undefined) delete process.env.KOBE_HOME_DIR
  else process.env.KOBE_HOME_DIR = savedHomeDir
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  } catch {}
})

async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(cond()).toBe(true)
}

describe("defaultUiPrefsStatePath", () => {
  test("resolves under the given home (mirror of kvStatePath in env.ts)", () => {
    expect(defaultUiPrefsStatePath("/some/home")).toBe(path.join("/some/home", ".config", "kobe", "state.json"))
  })
})

describe("readUiPrefsFromStateFile", () => {
  test("missing file yields the documented defaults", () => {
    expect(readUiPrefsFromStateFile(statePath)).toEqual({
      theme: "claude",
      transparentBackground: false,
      focusAccent: null,
      locale: "en",
      sortMode: "default",
      keysCollapsed: false,
      projectFilter: null,
    })
  })

  test("corrupt JSON yields defaults instead of throwing (State Store corrupt-file policy)", () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, "{not json", "utf8")
    expect(readUiPrefsFromStateFile(statePath)).toEqual({
      theme: "claude",
      transparentBackground: false,
      focusAccent: null,
      locale: "en",
      sortMode: "default",
      keysCollapsed: false,
      projectFilter: null,
    })
  })

  test("reads the visual keys; an unknown focusAccent slot is dropped to null", () => {
    patchStateFile({ activeTheme: "nord", transparentBackground: true, focusAccent: "chartreuse" })
    expect(readUiPrefsFromStateFile(statePath)).toEqual({
      theme: "nord",
      transparentBackground: true,
      focusAccent: null,
      locale: "en",
      sortMode: "default",
      keysCollapsed: false,
      projectFilter: null,
    })
  })

  test("reads activeSortMode; a non-`recent` value falls back to the default ordering", () => {
    patchStateFile({ activeSortMode: "recent" })
    expect(readUiPrefsFromStateFile(statePath).sortMode).toBe("recent")
    patchStateFile({ activeSortMode: "bogus" })
    expect(readUiPrefsFromStateFile(statePath).sortMode).toBe("default")
  })

  test("reads tasksPane.keysCollapsed; only an explicit true collapses the legend", () => {
    patchStateFile({ "tasksPane.keysCollapsed": true })
    expect(readUiPrefsFromStateFile(statePath).keysCollapsed).toBe(true)
    patchStateFile({ "tasksPane.keysCollapsed": false })
    expect(readUiPrefsFromStateFile(statePath).keysCollapsed).toBe(false)
  })

  test("reads tasksPane.projectFilter; only a non-empty string is kept", () => {
    patchStateFile({ "tasksPane.projectFilter": "/repo/kobe" })
    expect(readUiPrefsFromStateFile(statePath).projectFilter).toBe("/repo/kobe")
    patchStateFile({ "tasksPane.projectFilter": "" })
    expect(readUiPrefsFromStateFile(statePath).projectFilter).toBeNull()
  })

  test("mirrors locale verbatim (UI-neutral); empty/missing falls back to en", () => {
    patchStateFile({ locale: "zh" })
    expect(readUiPrefsFromStateFile(statePath).locale).toBe("zh")
    patchStateFile({ locale: "klingon" })
    expect(readUiPrefsFromStateFile(statePath).locale).toBe("klingon")
    patchStateFile({ locale: "" })
    expect(readUiPrefsFromStateFile(statePath).locale).toBe("en")
  })
})

describe("startUiPrefsWatcher", () => {
  test("publishes the current prefs immediately so late subscribers can replay", () => {
    patchStateFile({ activeTheme: "dracula", focusAccent: "info" })
    stop = startUiPrefsWatcher(bus, { statePath, debounceMs: 25 })
    expect(events).toEqual([
      {
        theme: "dracula",
        transparentBackground: false,
        focusAccent: "info",
        locale: "en",
        sortMode: "default",
        keysCollapsed: false,
        projectFilter: null,
      },
    ])
    expect(bus.snapshot().find((e) => e.channel === "ui-prefs")?.payload).toEqual(events[0])
  })

  test("a State-Store write (tmp+rename) is seen and published; unchanged values are not re-published", async () => {
    stop = startUiPrefsWatcher(bus, { statePath, debounceMs: 25 })
    expect(events).toHaveLength(1)

    patchStateFile({ activeTheme: "tokyonight", transparentBackground: true })
    await waitFor(() => events.length === 2)
    expect(events[1]).toEqual({
      theme: "tokyonight",
      transparentBackground: true,
      focusAccent: null,
      locale: "en",
      sortMode: "default",
      keysCollapsed: false,
      projectFilter: null,
    })

    patchStateFile({ lastSelectedVendor: "codex" })
    patchStateFile({ activeTheme: "tokyonight", transparentBackground: true })
    await new Promise((r) => setTimeout(r, 250))
    expect(events).toHaveLength(2)

    patchStateFile({ focusAccent: "success" })
    await waitFor(() => events.length === 3)
    expect(events[2]).toEqual({
      theme: "tokyonight",
      transparentBackground: true,
      focusAccent: "success",
      locale: "en",
      sortMode: "default",
      keysCollapsed: false,
      projectFilter: null,
    })
  })

  test("debounceMs <= 0 disables the watcher entirely (no publish, no-op stop)", () => {
    stop = startUiPrefsWatcher(bus, { statePath, debounceMs: 0 })
    expect(events).toHaveLength(0)
    stop()
    stop = null
  })

  test("stop() ends delivery", async () => {
    stop = startUiPrefsWatcher(bus, { statePath, debounceMs: 25 })
    stop()
    stop = null
    patchStateFile({ activeTheme: "nord" })
    await new Promise((r) => setTimeout(r, 250))
    expect(events).toHaveLength(1)
  })
})
