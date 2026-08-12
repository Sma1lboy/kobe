/**
 * `kobe api inspect` — hermetic offline run. No daemon, no PTY host: the
 * daemon/sessions sections must degrade to null (an honest "couldn't look",
 * never an error), while the offline sections still answer — the persisted
 * tab snapshots from state.json and, since issue #9, the durable session
 * death records from pty-exits.json (the one place a crashed engine's exit
 * code + output tail survives the host's idle-exit).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { invokeVerb } from "../../src/cli/api-cmd.ts"
import { tabsSection } from "../../src/cli/api/handlers-inspect.ts"

let home: string
const saved: Record<string, string | undefined> = {}
const ENV_KEYS = ["HOME", "KOBE_HOME_DIR", "KOBE_DAEMON_SOCKET_PATH", "KOBE_PTY_SOCKET_PATH"] as const

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kobe-inspect-"))
  for (const key of ENV_KEYS) saved[key] = process.env[key]
  process.env.HOME = home
  process.env.KOBE_HOME_DIR = home
  // Point both sockets at paths nothing listens on — the sections must
  // degrade to null instead of touching any real daemon/host.
  process.env.KOBE_DAEMON_SOCKET_PATH = join(home, "no-daemon.sock")
  process.env.KOBE_PTY_SOCKET_PATH = join(home, "no-pty.sock")
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = saved[key]
  }
  rmSync(home, { recursive: true, force: true })
})

function seedHome(): void {
  mkdirSync(join(home, ".config", "kobe"), { recursive: true })
  writeFileSync(
    join(home, ".config", "kobe", "state.json"),
    JSON.stringify({
      "terminalTabs.t1": {
        tabs: [{ kind: "engine", id: "tab-1", title: null, ordinal: 1, lastTitle: "crashed run" }],
        activeId: "tab-1",
        nextOrdinal: 2,
      },
    }),
    "utf8",
  )
  mkdirSync(join(home, ".kobe"), { recursive: true })
  writeFileSync(
    join(home, ".kobe", "pty-exits.json"),
    JSON.stringify({
      "t1::tab-1": {
        key: "t1::tab-1",
        pid: 74965,
        code: 1,
        signal: null,
        at: "2026-08-11T00:00:00.000Z",
        tail: ["FATAL: missing config"],
      },
      "other::tab-1": {
        key: "other::tab-1",
        pid: 1,
        code: null,
        signal: "SIGKILL",
        at: "2026-08-11T01:00:00.000Z",
        tail: [],
      },
    }),
    "utf8",
  )
}

type InspectResult = {
  daemon: unknown
  sessions: unknown
  sessionExits: Array<{ key: string; code: number | null; tail: string[] }>
  tabs: Record<string, { tabs: Array<{ id: string; lastTitle: string | null }> }>
}

describe("kobe api inspect (offline)", () => {
  it("degrades daemon/sessions to null and reads tabs + death records from disk", async () => {
    seedHome()
    const res = (await invokeVerb("inspect", [], { client: null })) as InspectResult
    expect(res.daemon).toBeNull()
    expect(res.sessions).toBeNull()
    expect(res.tabs.t1?.tabs[0]).toMatchObject({ id: "tab-1", lastTitle: "crashed run" })
    // Both records, host long gone — the issue-#9 "how did it die" read.
    expect(res.sessionExits).toHaveLength(2)
    expect(res.sessionExits.find((r) => r.key === "t1::tab-1")).toMatchObject({
      code: 1,
      tail: ["FATAL: missing config"],
    })
  })

  it("narrows every section to --task-id, including the death records", async () => {
    seedHome()
    const res = (await invokeVerb("inspect", ["--task-id", "t1"], { client: null })) as InspectResult
    expect(res.sessionExits).toHaveLength(1)
    expect(res.sessionExits[0]?.key).toBe("t1::tab-1")
    expect(Object.keys(res.tabs)).toEqual(["t1"])
  })

  it("missing state and records files read as empty, not errors", async () => {
    const res = (await invokeVerb("inspect", [], { client: null })) as InspectResult
    expect(res.sessionExits).toEqual([])
    expect(res.tabs).toEqual({})
  })
})

/**
 * The `tabs` section reconciled against the live session inventory (issue
 * #20): a live `<taskId>::tab-N` session the snapshot does not list must be
 * called out as `unregistered`, never silently dropped — that silence is how
 * a writable engine stayed invisible for 1h44m.
 */
describe("inspect tabs section reconciliation (issue #20)", () => {
  type TabsOut = Record<string, { activeId: string | null; tabs: { id: string }[]; unregistered?: string[] }>

  it("flags an alive session missing from the task's snapshot", () => {
    seedHome() // snapshot for t1: tab-1 only
    const out = tabsSection("t1", [
      { key: "t1::tab-1", alive: true },
      { key: "t1::tab-9", alive: true }, // alive on the host, unknown to the snapshot
    ]) as TabsOut
    expect(out.t1?.tabs.map((t) => t.id)).toEqual(["tab-1"])
    expect(out.t1?.unregistered).toEqual(["tab-9"])
  })

  it("reports a task with live sessions but no snapshot at all", () => {
    seedHome()
    const out = tabsSection(undefined, [{ key: "ghost::tab-1", alive: true }]) as TabsOut
    expect(out.ghost).toEqual({ activeId: null, tabs: [], unregistered: ["tab-1"] })
  })

  it("stays quiet when snapshot and sessions agree (and when sessions are unknowable)", () => {
    seedHome()
    const agreed = tabsSection("t1", [{ key: "t1::tab-1", alive: true }]) as TabsOut
    expect(agreed.t1?.unregistered).toBeUndefined()
    // Offline inspect passes the degraded sessions section (null) through.
    const offline = tabsSection("t1", null) as TabsOut
    expect(offline.t1?.unregistered).toBeUndefined()
  })
})
