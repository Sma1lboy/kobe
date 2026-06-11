/**
 * keybindings watcher (KOB — live keybinding propagation). Sibling of the
 * ui-prefs watcher: the daemon half of "edit keybindings.yaml and every
 * pane re-applies it live". Load-bearing mechanics it must not regress:
 *
 *   - watch the settings DIRECTORY so an editor's tmp+rename (which swaps
 *     the inode) doesn't silently kill the watch;
 *   - bump a monotonic `rev` on every change — the daemon carries no keymap
 *     data, only the "re-read now" token, so it deliberately does NOT diff
 *     content (the TUI owns validation);
 *   - seed the bus last-value cache at start so a late subscriber learns the
 *     channel's current rev.
 *
 * Isolated via KOBE_HOME_DIR → a temp home (defaultKeybindingsPath honours
 * it). Writes are plain fs writes — the file is owned by the user/editor,
 * not the State Store.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { type ChannelEvent, DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import {
  defaultKeybindingsPath,
  startKeybindingsWatcher,
} from "@sma1lboy/kobe-daemon/daemon/keybindings-watcher"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

let tmpHome: string
let filePath: string
let savedHomeDir: string | undefined
let bus: DaemonEventBus
let revs: number[]
let stop: (() => void) | null

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-keybinds-"))
  savedHomeDir = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
  filePath = defaultKeybindingsPath(tmpHome)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  bus = new DaemonEventBus()
  revs = []
  bus.onPublish((event: ChannelEvent) => {
    if (event.channel === "keybindings") revs.push((event.payload as { rev: number }).rev)
  })
  stop = null
})

afterEach(() => {
  stop?.()
  // biome-ignore lint/performance/noDelete: env cleanup must fully unset when the var was unset before the test. Same pattern as ui-prefs-watcher.test.ts.
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

describe("defaultKeybindingsPath", () => {
  test("resolves under the given home (mirror of keybindingsConfigPath in env.ts)", () => {
    expect(defaultKeybindingsPath("/some/home")).toBe(
      path.join("/some/home", ".kobe", "settings", "keybindings.yaml"),
    )
  })
})

describe("startKeybindingsWatcher", () => {
  test("publishes an initial rev immediately so late subscribers can replay", () => {
    stop = startKeybindingsWatcher(bus, { path: filePath, debounceMs: 25 })
    expect(revs).toEqual([0])
    // The bus last-value cache is warm — what a `subscribe` replays.
    expect(bus.snapshot().find((e) => e.channel === "keybindings")?.payload).toEqual({ rev: 0 })
  })

  test("a write to keybindings.yaml bumps the rev; the watcher survives rename writes", async () => {
    stop = startKeybindingsWatcher(bus, { path: filePath, debounceMs: 25 })
    expect(revs).toEqual([0]) // initial seed

    // tmp + rename — what an editor (or atomic writer) does; a file-watch
    // would go dead on this, a dir-watch survives.
    const tmp = `${filePath}.tmp`
    fs.writeFileSync(tmp, "chat.fork.new: ctrl+g\n", "utf8")
    fs.renameSync(tmp, filePath)
    await waitFor(() => revs.length === 2)
    expect(revs[1]).toBe(1)

    // A later edit bumps again (the watcher is alive after the rename).
    fs.writeFileSync(filePath, "chat.fork.new: ctrl+y\n", "utf8")
    await waitFor(() => revs.length === 3)
    expect(revs[2]).toBe(2)
  })

  test("debounceMs <= 0 disables the watcher entirely (no publish, no-op stop)", () => {
    stop = startKeybindingsWatcher(bus, { path: filePath, debounceMs: 0 })
    expect(revs).toHaveLength(0)
    stop()
    stop = null
  })

  test("stop() ends delivery", async () => {
    stop = startKeybindingsWatcher(bus, { path: filePath, debounceMs: 25 })
    stop()
    stop = null
    fs.writeFileSync(filePath, "chat.fork.new: ctrl+g\n", "utf8")
    await new Promise((r) => setTimeout(r, 250))
    expect(revs).toEqual([0]) // only the initial publish
  })
})
