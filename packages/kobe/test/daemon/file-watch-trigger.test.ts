/**
 * file-watch-trigger (shared dir-watch backing ui-prefs + keybindings fan-out).
 * Why these tests matter: this module is the load-bearing half of "edit a file
 * on disk → daemon refreshes the channel". After swapping the internals from
 * `node:fs.watch` + a manual poll fallback to chokidar, the EXTERNAL contract
 * the callers (ui-prefs-watcher, keybindings-watcher) depend on must be intact:
 *
 *   - it watches the parent DIRECTORY, not the file inode, so the State Store's
 *     atomic tmp+rename is still seen (an inode watch goes dead after rename);
 *   - it filters by basename, so unrelated siblings in the dir don't trigger;
 *   - it debounces bursts into a single trigger;
 *   - `debounceMs <= 0` is a no-op (callers use it as the "watching disabled"
 *     switch);
 *   - `stop()` fully closes the chokidar watcher — no further triggers, no
 *     leaked watchers/timers.
 *
 * These run against a real temp dir (chokidar is real-fs), with timeout-based
 * assertions because fs-event delivery is async. The old test surface lived in
 * the ui-prefs/keybindings watcher tests (also real-fs, kept green); this file
 * pins the shared primitive directly. No fs.watch was ever mocked, so there was
 * nothing to un-mock for the chokidar swap.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { startFileWatchTrigger } from "@sma1lboy/kobe-daemon/daemon/file-watch-trigger"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

let tmpDir: string
let filePath: string
let stop: (() => void) | null

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-fwt-"))
  filePath = path.join(tmpDir, "state.json")
  stop = null
})

afterEach(() => {
  stop?.()
  stop = null
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // ignored
  }
})

/** Poll until `cond` holds or ~2s elapses (fs-event delivery is async). */
async function waitFor(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!cond() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20))
  }
  expect(cond()).toBe(true)
}

describe("startFileWatchTrigger", () => {
  test("fires on a matching file add and on a later change", async () => {
    let triggers = 0
    let errors = 0
    stop = startFileWatchTrigger({
      filePath,
      debounceMs: 25,
      onTrigger: () => {
        triggers += 1
      },
      onError: () => {
        errors += 1
      },
    })

    // Create the watched file (add).
    fs.writeFileSync(filePath, "{}", "utf8")
    await waitFor(() => triggers >= 1)
    const afterAdd = triggers

    // Modify it (change).
    fs.writeFileSync(filePath, '{"x":1}', "utf8")
    await waitFor(() => triggers > afterAdd)

    expect(errors).toBe(0)
  })

  test("survives an atomic tmp+rename swap (dir watch, not inode watch)", async () => {
    let triggers = 0
    stop = startFileWatchTrigger({
      filePath,
      debounceMs: 25,
      onTrigger: () => {
        triggers += 1
      },
      onError: () => {},
    })

    // Production write path: write a tmp sibling, then rename it over the
    // target. An inode watch on `state.json` would miss this.
    const tmp = path.join(tmpDir, "state.json.tmp")
    fs.writeFileSync(tmp, "{}", "utf8")
    fs.renameSync(tmp, filePath)
    await waitFor(() => triggers >= 1)

    // A second rename still lands — the watcher is alive after the first swap.
    const before = triggers
    fs.writeFileSync(tmp, '{"x":2}', "utf8")
    fs.renameSync(tmp, filePath)
    await waitFor(() => triggers > before)
  })

  test("ignores siblings that don't match the watched basename(s)", async () => {
    let triggers = 0
    stop = startFileWatchTrigger({
      filePath,
      matchBasenames: ["alias.json"],
      debounceMs: 25,
      onTrigger: () => {
        triggers += 1
      },
      onError: () => {},
    })

    // An unrelated file in the same directory must NOT trigger.
    fs.writeFileSync(path.join(tmpDir, "unrelated.txt"), "noise", "utf8")
    await new Promise((r) => setTimeout(r, 300))
    expect(triggers).toBe(0)

    // An additional matched basename DOES trigger.
    fs.writeFileSync(path.join(tmpDir, "alias.json"), "{}", "utf8")
    await waitFor(() => triggers >= 1)
  })

  test("debounces a burst of events into a single trigger", async () => {
    let triggers = 0
    stop = startFileWatchTrigger({
      filePath,
      debounceMs: 80,
      onTrigger: () => {
        triggers += 1
      },
      onError: () => {},
    })

    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(filePath, `{"n":${i}}`, "utf8")
    }
    await waitFor(() => triggers >= 1)
    // Let the debounce window settle; the burst must not produce 5 triggers.
    await new Promise((r) => setTimeout(r, 200))
    expect(triggers).toBe(1)
  })

  test("debounceMs <= 0 is a no-op (no trigger, no-op stop)", async () => {
    let triggers = 0
    stop = startFileWatchTrigger({
      filePath,
      debounceMs: 0,
      onTrigger: () => {
        triggers += 1
      },
      onError: () => {},
    })
    fs.writeFileSync(filePath, "{}", "utf8")
    await new Promise((r) => setTimeout(r, 250))
    expect(triggers).toBe(0)
    // stop() is safe to call.
    stop()
    stop = null
  })

  test("stop() closes cleanly — no triggers after stop", async () => {
    let triggers = 0
    const localStop = startFileWatchTrigger({
      filePath,
      debounceMs: 25,
      onTrigger: () => {
        triggers += 1
      },
      onError: () => {},
    })
    // Confirm it's live first.
    fs.writeFileSync(filePath, "{}", "utf8")
    await waitFor(() => triggers >= 1)
    const before = triggers

    localStop()
    // A pending debounce must not fire after stop, and later edits are ignored.
    fs.writeFileSync(filePath, '{"x":9}', "utf8")
    await new Promise((r) => setTimeout(r, 300))
    expect(triggers).toBe(before)

    // Double-stop is safe.
    localStop()
  })
})
