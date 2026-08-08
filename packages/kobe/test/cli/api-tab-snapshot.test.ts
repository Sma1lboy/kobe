/**
 * The CLI publishes a tab snapshot for sessions it starts.
 *
 * The sidebar tree lists a worktree's tabs from `terminalTabs.<taskId>`,
 * which only a mounted `TerminalTabs` ever wrote — so a headless start
 * (`kobe api add --prompt`, `kobe api send`, a routine firing) ran a live
 * engine that the tree could not see, and rendered the worktree with no tabs
 * at all. Since headless start is how agent-driven work enters kobe, that was
 * most of the fleet.
 *
 * The write-once rule is the load-bearing half: a mounted TUI owns tab state
 * for real (ordinals, titles, splits), and `kobe api send` into a task you
 * have open reuses that session — so clobbering its snapshot with a one-tab
 * stub would actively destroy state.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { publishCliTabSnapshot } from "../../src/cli/api/tab-snapshot.ts"

let home: string
let originalHome: string | undefined

const statePath = (): string => join(home, ".config", "kobe", "state.json")

function writeState(state: Record<string, unknown>): void {
  mkdirSync(join(home, ".config", "kobe"), { recursive: true })
  writeFileSync(statePath(), JSON.stringify(state), "utf8")
}

function readState(): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath(), "utf8"))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kobe-cli-tabsnap-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = home
})

afterEach(() => {
  if (originalHome === undefined) {
    // biome-ignore lint/performance/noDelete: the var must be truly unset when it started unset.
    delete process.env.KOBE_HOME_DIR
  } else process.env.KOBE_HOME_DIR = originalHome
  rmSync(home, { recursive: true, force: true })
})

describe("publishCliTabSnapshot", () => {
  it("seeds the canonical first engine tab so the tree can render a row", () => {
    writeState({})
    publishCliTabSnapshot("t1")
    const snapshot = readState()["terminalTabs.t1"] as { tabs: { id: string; kind: string }[]; activeId: string }
    // `tab-1` matches the pty key the CLI launch path uses (`engineSessionKey`
    // → `<taskId>::tab-1`), so the row and the live process agree.
    expect(snapshot.tabs).toHaveLength(1)
    expect(snapshot.tabs[0]).toMatchObject({ id: "tab-1", kind: "engine" })
    expect(snapshot.activeId).toBe("tab-1")
  })

  it("never overwrites an existing snapshot — a mounted TUI owns tab state", () => {
    const mine = {
      tabs: [{ kind: "engine", id: "tab-7", title: "mine", ordinal: 7 }],
      activeId: "tab-7",
      nextOrdinal: 8,
    }
    writeState({ "terminalTabs.t1": mine })
    publishCliTabSnapshot("t1")
    expect(readState()["terminalTabs.t1"]).toEqual(mine)
  })

  it("leaves other tasks' snapshots untouched", () => {
    writeState({ "terminalTabs.other": { tabs: [], activeId: "tab-1", nextOrdinal: 2 }, unrelated: "keep" })
    publishCliTabSnapshot("t1")
    const state = readState()
    expect(state["terminalTabs.other"]).toEqual({ tabs: [], activeId: "tab-1", nextOrdinal: 2 })
    expect(state.unrelated).toBe("keep")
    expect(state["terminalTabs.t1"]).toBeDefined()
  })

  it("ignores an empty task id instead of writing a junk key", () => {
    writeState({})
    publishCliTabSnapshot("")
    expect(Object.keys(readState())).toEqual([])
  })
})
