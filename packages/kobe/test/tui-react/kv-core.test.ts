/**
 * Framework-free KV core (src/tui-react/context/kv-core.ts) — the React
 * KVProvider's persistence half. These tests pin the semantics the Solid
 * provider fought for and the React port must not regress:
 *
 *   - DIRTY-KEY MERGE on flush: only keys THIS core `set()` reach disk; a
 *     key another process wrote after hydration passes through untouched
 *     (the multi-process lost-update bug).
 *   - `seed()` (the signal-default path) is in-memory only — reading a
 *     default must never persist it.
 *   - `set(key, undefined)` serializes as a DELETION.
 *   - `clear()` is the one whole-file write: it wipes even foreign keys.
 *   - Writes are debounced (250ms) — no disk write before the window.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createKvCore } from "../../src/tui-react/context/kv-core"

let savedHome: string | undefined

beforeEach(() => {
  savedHome = process.env.KOBE_HOME_DIR
})

afterEach(() => {
  // Reflect.deleteProperty (not `= undefined`): assigning undefined to a
  // process.env key stores the string "undefined" under node.
  if (savedHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = savedHome
  vi.useRealTimers()
})

function isolatedHome(initial?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "kobe-kv-core-"))
  process.env.KOBE_HOME_DIR = home
  if (initial) writeState(home, initial)
  return home
}

function statePath(home: string): string {
  return join(home, ".config", "kobe", "state.json")
}

function writeState(home: string, state: Record<string, unknown>): void {
  mkdirSync(join(home, ".config", "kobe"), { recursive: true })
  writeFileSync(statePath(home), JSON.stringify(state, null, 2), "utf8")
}

function readState(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath(home), "utf8")) as Record<string, unknown>
}

describe("createKvCore", () => {
  it("hydrates synchronously from state.json and falls back to defaults", () => {
    isolatedHome({ activeTheme: "tokyonight" })
    const kv = createKvCore()
    expect(kv.get("activeTheme")).toBe("tokyonight")
    expect(kv.get("missing", "fallback")).toBe("fallback")
    expect(kv.snapshot()).toEqual({ activeTheme: "tokyonight" })
  })

  it("treats a missing state file as an empty store", () => {
    isolatedHome()
    const kv = createKvCore()
    expect(kv.snapshot()).toEqual({})
  })

  it("flushes ONLY dirty keys, preserving another process's concurrent write", () => {
    const home = isolatedHome({ shared: "old", mine: "old" })
    const kv = createKvCore()
    kv.set("mine", "new")
    // Another kobe process writes a DIFFERENT key after our hydration.
    writeState(home, { shared: "theirs", mine: "old" })
    expect(kv.flush()).toBe(true)
    expect(readState(home)).toEqual({ shared: "theirs", mine: "new" })
  })

  it("serializes set(key, undefined) as a deletion", () => {
    const home = isolatedHome({ doomed: 1, kept: 2 })
    const kv = createKvCore()
    kv.set("doomed", undefined)
    expect(kv.flush()).toBe(true)
    expect(readState(home)).toEqual({ kept: 2 })
  })

  it("seed() is visible in memory but never persisted", () => {
    const home = isolatedHome({ existing: "x" })
    const kv = createKvCore()
    kv.seed("someDefault", true)
    kv.seed("existing", "would-clobber") // no-op: key already set
    expect(kv.get("someDefault")).toBe(true)
    expect(kv.get("existing")).toBe("x")
    expect(kv.flush()).toBe(true) // nothing dirty → no write needed
    expect(readState(home)).toEqual({ existing: "x" })
  })

  it("debounces writes (nothing on disk before the 250ms window)", () => {
    vi.useFakeTimers()
    const home = isolatedHome({})
    const kv = createKvCore()
    kv.set("k", "v")
    expect(readState(home)).toEqual({})
    vi.advanceTimersByTime(300)
    expect(readState(home)).toEqual({ k: "v" })
  })

  it("clear() wipes the whole file, including keys other processes wrote", () => {
    const home = isolatedHome({ mine: 1 })
    const kv = createKvCore()
    kv.set("mine", 2)
    writeState(home, { mine: 1, theirs: 3 })
    kv.clear()
    expect(kv.snapshot()).toEqual({})
    expect(readState(home)).toEqual({})
    // Pending dirty keys must not survive the wipe via a later flush.
    expect(kv.flush()).toBe(true)
    expect(readState(home)).toEqual({})
  })

  it("notifies subscribers on set and supports unsubscribe", () => {
    isolatedHome()
    const kv = createKvCore()
    const seen: unknown[] = []
    const unsubscribe = kv.subscribe(() => seen.push(kv.get("k")))
    kv.set("k", 1)
    kv.set("k", 2)
    unsubscribe()
    kv.set("k", 3)
    expect(seen).toEqual([1, 2])
  })
})
