/**
 * Tests for the geometry-hook coordination primitives
 * (`src/tui/panes/terminal/layout-coord.ts`) and the drag gate
 * (`pane-heal.ts` `shouldCaptureDrag`).
 *
 * These guard the two behaviours the live hooks depend on:
 *   - a burst of `window-resized` / `window-layout-changed` firings collapses
 *     to ONE run (trailing debounce, last firing wins);
 *   - a `window-layout-changed` is captured as a drag only when it is safe to
 *     (not zoomed, full role set) — the resize-recency half is the caller's.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { shouldCaptureDrag } from "../../src/tui/panes/terminal/pane-heal"

let home: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env.KOBE_HOME_DIR
  home = mkdtempSync(join(tmpdir(), "kobe-coord-"))
  process.env.KOBE_HOME_DIR = home
})

afterEach(() => {
  if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = prevHome
  rmSync(home, { recursive: true, force: true })
})

describe("recordGen / isLatestGen", () => {
  test("a fresh stamp supersedes an earlier one for the same session+kind", async () => {
    const { recordGen, isLatestGen } = await import("../../src/tui/panes/terminal/layout-coord")
    const first = recordGen("kobe-a", "heal")
    expect(isLatestGen("kobe-a", "heal", first)).toBe(true)
    const second = recordGen("kobe-a", "heal")
    expect(isLatestGen("kobe-a", "heal", first)).toBe(false) // first superseded
    expect(isLatestGen("kobe-a", "heal", second)).toBe(true)
  })

  test("session and kind are isolated", async () => {
    const { recordGen, isLatestGen } = await import("../../src/tui/panes/terminal/layout-coord")
    const a = recordGen("kobe-a", "heal")
    recordGen("kobe-b", "heal") // different session
    recordGen("kobe-a", "capture") // different kind
    expect(isLatestGen("kobe-a", "heal", a)).toBe(true)
  })

  test("never-stamped nonce reads as latest (degrade to proceed)", async () => {
    const { isLatestGen } = await import("../../src/tui/panes/terminal/layout-coord")
    expect(isLatestGen("kobe-missing", "heal", "whatever")).toBe(true)
  })
})

describe("genAgeMs", () => {
  test("is small right after a stamp and Infinity when never stamped", async () => {
    const { recordGen, genAgeMs } = await import("../../src/tui/panes/terminal/layout-coord")
    expect(genAgeMs("kobe-x", "heal")).toBe(Number.POSITIVE_INFINITY)
    recordGen("kobe-x", "heal")
    expect(genAgeMs("kobe-x", "heal")).toBeLessThan(1000)
  })

  test("reports the elapsed time against an injected clock", async () => {
    const { recordGen, genAgeMs } = await import("../../src/tui/panes/terminal/layout-coord")
    recordGen("kobe-x", "heal")
    const age = genAgeMs("kobe-x", "heal", Date.now() + 5000)
    expect(age).toBeGreaterThanOrEqual(5000)
    expect(age).toBeLessThan(6000)
  })
})

describe("coalesceLayoutWork", () => {
  test("runs the work when no later firing supersedes it", async () => {
    const { coalesceLayoutWork } = await import("../../src/tui/panes/terminal/layout-coord")
    let ran = 0
    await coalesceLayoutWork(
      "kobe-s",
      "heal",
      async () => {
        ran++
      },
      0,
    )
    expect(ran).toBe(1)
  })

  test("a superseded firing does no work (trailing debounce)", async () => {
    const { coalesceLayoutWork, recordGen } = await import("../../src/tui/panes/terminal/layout-coord")
    let ran = 0
    // Start a firing with a real debounce window, then supersede it mid-wait.
    const inflight = coalesceLayoutWork(
      "kobe-s",
      "heal",
      async () => {
        ran++
      },
      40,
    )
    recordGen("kobe-s", "heal") // a later firing stamps over the inflight one
    await inflight
    expect(ran).toBe(0)
  })
})

describe("shouldCaptureDrag", () => {
  test("captures a stable drag with the full role set, no zoom", () => {
    expect(shouldCaptureDrag("tasks\t0\nclaude\t0\nops\t0\nshell\t0\n")).toBe(true)
  })

  test("skips when any pane is zoomed (geometry reads as garbage)", () => {
    expect(shouldCaptureDrag("tasks\t0\nclaude\t1\nops\t0\nshell\t0\n")).toBe(false)
  })

  test("skips a half-built layout missing a role (no ops yet)", () => {
    expect(shouldCaptureDrag("tasks\t0\nclaude\t0\n")).toBe(false)
  })

  test("skips while the terminal is hidden in a background window", () => {
    expect(shouldCaptureDrag("tasks\t0\t%9\nclaude\t0\t%9\nops\t0\t%9\n")).toBe(false)
  })

  test("skips while the Tasks pane is hidden in a background window", () => {
    expect(shouldCaptureDrag("claude\t0\t\t%8\nops\t0\t\t%8\nshell\t0\t\t%8\n")).toBe(false)
  })

  test("skips an empty / role-less listing", () => {
    expect(shouldCaptureDrag("")).toBe(false)
    expect(shouldCaptureDrag("\t0\n\t0\n")).toBe(false)
  })
})
