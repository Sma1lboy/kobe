/**
 * ui-prefs watcher (KOB — live theme propagation). Why these tests matter:
 * the watcher is the daemon half of "a theme switch in one session restyles
 * every pane". Its load-bearing mechanics are easy to regress silently:
 *
 *   - it must watch the state.json DIRECTORY and survive the State Store's
 *     atomic tmp+rename (an fs.watch on the file itself goes dead after the
 *     first write — panes would stop following prefs with no error);
 *   - it must publish ONLY when the visual prefs actually changed, so the
 *     many non-visual keys in state.json (saved repos, engine commands…)
 *     don't make every pane re-apply on unrelated churn;
 *   - it must seed the bus's last-value cache at start so a late subscriber
 *     replays the current prefs.
 *
 * The writes here go through the real State Store (`patchStateFile`), so
 * the test exercises the exact tmp+rename pattern production uses. Isolated
 * via KOBE_HOME_DIR → a temp home (kvStatePath honours it).
 */

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
  } catch {
    // ignored
  }
})

/** Poll until `cond` holds or ~2s elapses (fs.watch delivery is async). */
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
      sortMode: "default",
    })
  })

  test("corrupt JSON yields defaults instead of throwing (State Store corrupt-file policy)", () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true })
    fs.writeFileSync(statePath, "{not json", "utf8")
    expect(readUiPrefsFromStateFile(statePath)).toEqual({
      theme: "claude",
      transparentBackground: false,
      focusAccent: null,
      sortMode: "default",
    })
  })

  test("reads the visual keys; an unknown focusAccent slot is dropped to null", () => {
    patchStateFile({ activeTheme: "nord", transparentBackground: true, focusAccent: "chartreuse" })
    expect(readUiPrefsFromStateFile(statePath)).toEqual({
      theme: "nord",
      transparentBackground: true,
      focusAccent: null,
      sortMode: "default",
    })
  })

  test("reads activeSortMode; a non-`recent` value falls back to the default ordering", () => {
    patchStateFile({ activeSortMode: "recent" })
    expect(readUiPrefsFromStateFile(statePath).sortMode).toBe("recent")
    patchStateFile({ activeSortMode: "bogus" })
    expect(readUiPrefsFromStateFile(statePath).sortMode).toBe("default")
  })
})

describe("startUiPrefsWatcher", () => {
  test("publishes the current prefs immediately so late subscribers can replay", () => {
    patchStateFile({ activeTheme: "dracula", focusAccent: "info" })
    stop = startUiPrefsWatcher(bus, { statePath, debounceMs: 25 })
    expect(events).toEqual([
      { theme: "dracula", transparentBackground: false, focusAccent: "info", sortMode: "default" },
    ])
    // The bus last-value cache is warm — what a `subscribe` replays.
    expect(bus.snapshot().find((e) => e.channel === "ui-prefs")?.payload).toEqual(events[0])
  })

  test("a State-Store write (tmp+rename) is seen and published; unchanged values are not re-published", async () => {
    stop = startUiPrefsWatcher(bus, { statePath, debounceMs: 25 })
    expect(events).toHaveLength(1) // initial defaults

    // Real production write path: tmp + rename swaps the inode, which is
    // exactly the case a file-watch (instead of dir-watch) would go dead on.
    patchStateFile({ activeTheme: "tokyonight", transparentBackground: true })
    await waitFor(() => events.length === 2)
    expect(events[1]).toEqual({
      theme: "tokyonight",
      transparentBackground: true,
      focusAccent: null,
      sortMode: "default",
    })

    // A write that doesn't move the visual prefs (an unrelated key, then
    // the SAME visual values again) publishes nothing.
    patchStateFile({ lastSelectedVendor: "codex" })
    patchStateFile({ activeTheme: "tokyonight", transparentBackground: true })
    await new Promise((r) => setTimeout(r, 250))
    expect(events).toHaveLength(2)

    // A later real change still lands (the watcher is alive after renames).
    patchStateFile({ focusAccent: "success" })
    await waitFor(() => events.length === 3)
    expect(events[2]).toEqual({
      theme: "tokyonight",
      transparentBackground: true,
      focusAccent: "success",
      sortMode: "default",
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
    expect(events).toHaveLength(1) // only the initial publish
  })
})
