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
import {
  hasLiveEngineTab,
  joinTaskTabs,
  markCliTabSession,
  mintCliTab,
  publishCliTabSnapshot,
  readTabsSnapshot,
} from "../../src/cli/api/tab-snapshot.ts"
import type { TabsState } from "../../src/tui/workspace/terminal-tabs-core.ts"

let home: string
let originalHome: string | undefined

const statePath = (): string => join(home, ".config", "rove", "state.json")

function writeState(state: Record<string, unknown>): void {
  mkdirSync(join(home, ".config", "rove"), { recursive: true })
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

  it("records the pinned session id + spawned when the delivery started the session", () => {
    writeState({})
    publishCliTabSnapshot("t1", "uuid-abc")
    const snapshot = readState()["terminalTabs.t1"] as {
      tabs: { id: string; sessionId?: string; spawned?: boolean }[]
    }
    // The dead-reattach rule (engineTabArgv) reads exactly these two fields
    // to `--resume` the conversation after a pty-host restart.
    expect(snapshot.tabs[0]).toMatchObject({ id: "tab-1", sessionId: "uuid-abc", spawned: true })
  })
})

describe("markCliTabSession", () => {
  it("patches an existing minted tab with its session id once the session started", () => {
    writeState({})
    const id = mintCliTab("t1")
    markCliTabSession("t1", id, "uuid-xyz")
    const snapshot = readState()["terminalTabs.t1"] as {
      tabs: { id: string; sessionId?: string; spawned?: boolean }[]
    }
    expect(snapshot.tabs.find((t) => t.id === id)).toMatchObject({ sessionId: "uuid-xyz", spawned: true })
    // The canonical tab keeps having no id — its session was never CLI-pinned.
    expect(snapshot.tabs.find((t) => t.id === "tab-1")?.sessionId).toBeUndefined()
  })

  it("is a no-op for an unknown tab or a missing snapshot", () => {
    writeState({})
    markCliTabSession("t1", "tab-9", "uuid-xyz")
    expect(readState()).toEqual({})
  })
})

describe("mintCliTab", () => {
  it("consumes the snapshot's nextOrdinal so CLI and TUI ids never collide", () => {
    writeState({
      "terminalTabs.t1": {
        tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1 }],
        activeId: "tab-1",
        nextOrdinal: 4, // TUI already minted tab-2/tab-3 and closed them
      },
    })
    const id = mintCliTab("t1")
    expect(id).toBe("tab-4")
    const snapshot = readState()["terminalTabs.t1"] as {
      tabs: { id: string }[]
      activeId: string
      nextOrdinal: number
    }
    expect(snapshot.tabs.map((t) => t.id)).toEqual(["tab-1", "tab-4"])
    expect(snapshot.activeId).toBe("tab-4")
    expect(snapshot.nextOrdinal).toBe(5)
  })

  it("seeds a task with no snapshot and mints tab-2 alongside the canonical tab", () => {
    writeState({})
    const id = mintCliTab("t1")
    expect(id).toBe("tab-2")
    const snapshot = readState()["terminalTabs.t1"] as { tabs: { id: string }[] }
    expect(snapshot.tabs.map((t) => t.id)).toEqual(["tab-1", "tab-2"])
  })
})

describe("readTabsSnapshot", () => {
  it("returns the persisted snapshot and undefined for absent/malformed keys", () => {
    const snap = { tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1 }], activeId: "tab-1", nextOrdinal: 2 }
    writeState({ "terminalTabs.t1": snap, "terminalTabs.bad": { tabs: "nope" } })
    expect(readTabsSnapshot("t1")).toEqual(snap)
    expect(readTabsSnapshot("bad")).toBeUndefined()
    expect(readTabsSnapshot("missing")).toBeUndefined()
  })
})

describe("hasLiveEngineTab (the get-task/collect .running rule)", () => {
  const snapshot = (tabs: unknown[]): TabsState =>
    ({ tabs, activeId: "tab-1", nextOrdinal: tabs.length + 1 }) as unknown as TabsState

  it("counts a live LATER engine tab when tab-1 is dead — the issue-#5 bug", () => {
    const snap = snapshot([
      { kind: "engine", id: "tab-1", title: null, ordinal: 1 },
      { kind: "engine", id: "tab-2", title: null, ordinal: 2 },
    ])
    const sessions = [
      { key: "t1::tab-1", alive: false },
      { key: "t1::tab-2", alive: true },
    ]
    expect(hasLiveEngineTab(snap, "t1", sessions)).toBe(true)
  })

  it("a live canonical tab-1 counts even with no snapshot (headless start, snapshot write failed)", () => {
    expect(hasLiveEngineTab(undefined, "t1", [{ key: "t1::tab-1", alive: true }])).toBe(true)
  })

  it("non-engine tabs and other tasks' sessions never count", () => {
    const snap = snapshot([
      { kind: "engine", id: "tab-1", title: null, ordinal: 1 },
      { kind: "command", id: "tab-2", title: "editor", ordinal: 2, command: ["nvim"] },
    ])
    const sessions = [
      { key: "t1::tab-1", alive: false },
      { key: "t1::tab-2", alive: true }, // command tab — a paste target this must never bless
      { key: "t2::tab-1", alive: true }, // someone else's task
    ]
    expect(hasLiveEngineTab(snap, "t1", sessions)).toBe(false)
  })

  it("a split's extra shell leaf does not make the tab read alive", () => {
    const snap = snapshot([{ kind: "engine", id: "tab-2", title: null, ordinal: 2 }])
    expect(hasLiveEngineTab(snap, "t1", [{ key: "t1::tab-2::leaf-2", alive: true }])).toBe(false)
  })
})

describe("joinTaskTabs", () => {
  it("maps snapshot fields and joins per-tab liveness on the tab's own key", () => {
    const snap = {
      tabs: [
        { kind: "engine", id: "tab-1", title: "renamed", ordinal: 1, lastTitle: "building", autoTitle: "first prompt" },
        { kind: "engine", id: "tab-2", title: null, ordinal: 2, vendor: "codex", liveVendor: "codex" },
      ],
      activeId: "tab-2",
      nextOrdinal: 3,
    } as unknown as TabsState
    const rows = joinTaskTabs(snap, "t1", [
      { key: "t1::tab-2", alive: true },
      { key: "t1::tab-1::leaf-2", alive: true }, // split shell leaf — not the tab itself
    ])
    expect(rows).toEqual([
      {
        id: "tab-1",
        kind: "engine",
        title: "renamed",
        vendor: null,
        liveVendor: null,
        lastTitle: "building",
        autoTitle: "first prompt",
        alive: false,
        exit: null,
      },
      {
        id: "tab-2",
        kind: "engine",
        title: null,
        vendor: "codex",
        liveVendor: "codex",
        lastTitle: null,
        autoTitle: null,
        alive: true,
        exit: null,
      },
    ])
  })

  const vendorSnap = (tabs: unknown[]): TabsState =>
    ({ tabs, activeId: "tab-1", nextOrdinal: tabs.length + 1 }) as unknown as TabsState

  it("a live foreground-walk verdict overrides the recorded liveVendor (issue #33)", () => {
    const snap = vendorSnap([
      { kind: "command", id: "tab-1", title: null, ordinal: 1 }, // shell, user typed claude
      { kind: "engine", id: "tab-2", title: null, ordinal: 2, liveVendor: "codex" }, // ctrl+C'd
      { kind: "engine", id: "tab-3", title: null, ordinal: 3, liveVendor: "codex" }, // not walked
    ])
    const rows = joinTaskTabs(
      snap,
      "t1",
      [
        { key: "t1::tab-1", alive: true },
        { key: "t1::tab-2", alive: true },
        { key: "t1::tab-3", alive: true },
      ],
      {},
      new Map([
        ["t1::tab-1", "claude"], // shell running a live engine → lights up
        ["t1::tab-2", null], // walked, engine-free → goes dark
        // tab-3 absent: couldn't look → recorded value stands
      ]),
    )
    expect(rows.map((r) => r.liveVendor)).toEqual(["claude", null, "codex"])
  })

  it("a dead tab never takes a walk verdict — recorded liveVendor stands", () => {
    const snap = vendorSnap([{ kind: "engine", id: "tab-1", title: null, ordinal: 1, liveVendor: "claude" }])
    const rows = joinTaskTabs(snap, "t1", [{ key: "t1::tab-1", alive: false }], {}, new Map([["t1::tab-1", null]]))
    expect(rows[0]?.liveVendor).toBe("claude")
  })

  it("a task with no snapshot still lists its live sessions as unregistered rows", () => {
    // Before issue #20 this returned [] — an alive engine invisible to the
    // discovery read.
    expect(joinTaskTabs(undefined, "t1", [{ key: "t1::tab-1", alive: true }])).toEqual([
      {
        id: "tab-1",
        kind: "engine",
        title: null,
        vendor: null,
        liveVendor: null,
        lastTitle: null,
        autoTitle: null,
        alive: true,
        exit: null,
        unregistered: true,
      },
    ])
  })

  it("surfaces an alive session the snapshot does not list — the issue-#20 invisible engine", () => {
    // The incident replay: snapshot holds only tab-2, yet the pty host has
    // tab-1 + tab-2 alive. tab-1 ran for 1h44m with zero UI presence.
    const snap = {
      tabs: [{ kind: "engine", id: "tab-2", title: null, ordinal: 2 }],
      activeId: "tab-2",
      nextOrdinal: 3,
    } as unknown as TabsState
    const rows = joinTaskTabs(snap, "t1", [
      { key: "t1::tab-1", alive: true },
      { key: "t1::tab-2", alive: true },
    ])
    expect(rows.map((r) => ({ id: r.id, alive: r.alive, unregistered: r.unregistered ?? false }))).toEqual([
      { id: "tab-2", alive: true, unregistered: false },
      { id: "tab-1", alive: true, unregistered: true },
    ])
  })

  it("dead sessions and split leaves never mint unregistered rows", () => {
    const snap = {
      tabs: [{ kind: "engine", id: "tab-2", title: null, ordinal: 2 }],
      activeId: "tab-2",
      nextOrdinal: 3,
    } as unknown as TabsState
    const rows = joinTaskTabs(snap, "t1", [
      { key: "t1::tab-1", alive: false }, // dead — the exit records answer for it
      { key: "t1::tab-2::leaf-1", alive: true }, // split leaf — belongs to tab-2
      { key: "t1::tab-2", alive: true },
    ])
    expect(rows.map((r) => r.id)).toEqual(["tab-2"])
  })

  const oneTabSnap = (id: string): TabsState =>
    ({ tabs: [{ kind: "engine", id, title: null, ordinal: 1 }], activeId: id, nextOrdinal: 2 }) as TabsState

  it("surfaces a dead tab's abnormal exit from the live host session", () => {
    const exit = { code: 1, signal: null, at: "2026-08-11T00:00:00.000Z" }
    const rows = joinTaskTabs(oneTabSnap("tab-1"), "t1", [{ key: "t1::tab-1", alive: false, exit }])
    expect(rows[0]).toMatchObject({ alive: false, exit })
  })

  it("falls back to the durable exit record when the host has no session (idle-exited)", () => {
    const exit = { code: null, signal: "SIGKILL", at: "2026-08-11T00:00:00.000Z" }
    const rows = joinTaskTabs(oneTabSnap("tab-1"), "t1", [], { "t1::tab-1": exit })
    expect(rows[0]).toMatchObject({ alive: false, exit })
  })

  it("keeps clean exits quiet: code 0 reports exit null (issue #9 no-noise rule)", () => {
    const exit = { code: 0, signal: null, at: "2026-08-11T00:00:00.000Z" }
    const rows = joinTaskTabs(oneTabSnap("tab-1"), "t1", [{ key: "t1::tab-1", alive: false, exit }])
    expect(rows[0]?.exit).toBeNull()
  })

  it("an alive tab never reports an exit, even with a stale record for its key", () => {
    const stale = { code: 1, signal: null, at: "2026-08-10T00:00:00.000Z" }
    const rows = joinTaskTabs(oneTabSnap("tab-1"), "t1", [{ key: "t1::tab-1", alive: true }], { "t1::tab-1": stale })
    expect(rows[0]).toMatchObject({ alive: true, exit: null })
  })
})
