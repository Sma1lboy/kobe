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
  } catch {}
})

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

    fs.writeFileSync(filePath, "{}", "utf8")
    await waitFor(() => triggers >= 1)
    const afterAdd = triggers

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

    const tmp = path.join(tmpDir, "state.json.tmp")
    fs.writeFileSync(tmp, "{}", "utf8")
    fs.renameSync(tmp, filePath)
    await waitFor(() => triggers >= 1)

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

    fs.writeFileSync(path.join(tmpDir, "unrelated.txt"), "noise", "utf8")
    await new Promise((r) => setTimeout(r, 300))
    expect(triggers).toBe(0)

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
    fs.writeFileSync(filePath, "{}", "utf8")
    await waitFor(() => triggers >= 1)
    const before = triggers

    localStop()
    fs.writeFileSync(filePath, '{"x":9}', "utf8")
    await new Promise((r) => setTimeout(r, 300))
    expect(triggers).toBe(before)

    localStop()
  })
})
