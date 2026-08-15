/**
 * PtyHost freeze/restore semantics, driven through a fake `PtyDriver` so
 * spawn/respawn/exit are fully deterministic (no real PTY under vitest).
 * The pinned contract:
 *   - live output freezes THROTTLED; exit and flushFrozen freeze NOW;
 *   - a thawed session is a dead "restored" corpse whose first `open`
 *     respawns the child IN PLACE (old ring kept, caller's spec wins);
 *   - a failed respawn degrades to an ordinary view-only corpse;
 *   - explicit kill drops the record (a close is not a restart casualty);
 *   - the warm spare ("::spare") never freezes.
 */

import type { PtyChild, PtyDriver, PtyExit } from "@sma1lboy/kobe-daemon/daemon/pty-driver"
import type { FrozenPtySession, PtyFreezeSink } from "@sma1lboy/kobe-daemon/daemon/pty-freeze-store"
import { PtyHost } from "@sma1lboy/kobe-daemon/daemon/pty-host"
import { describe, expect, it } from "vitest"

class FakeChild {
  static nextPid = 1000
  readonly pid = FakeChild.nextPid++
  readonly written: string[] = []
  resized: { cols: number; rows: number } | null = null
  killed: NodeJS.Signals[] = []
  private settle!: (exit: PtyExit) => void
  readonly exited = new Promise<PtyExit>((resolve) => {
    this.settle = resolve
  })
  constructor(private readonly onData: (data: string | Uint8Array) => void) {}
  write(data: string): void {
    this.written.push(data)
    this.onData(data) // echo, like /bin/cat
  }
  resize(cols: number, rows: number): void {
    this.resized = { cols, rows }
  }
  close(): void {}
  kill(signal: NodeJS.Signals): void {
    this.killed.push(signal)
    this.settle({ code: null, signal })
  }
  /** Test-only: make the child exit on its own. */
  exit(code: number): void {
    this.settle({ code, signal: null })
  }
}

interface Harness {
  host: PtyHost
  children: FakeChild[]
  saved: Map<string, FrozenPtySession>
  requests: Array<{ argv: readonly string[]; cwd: string }>
  failNextSpawn: () => void
}

function harness(): Harness {
  const children: FakeChild[] = []
  const saved = new Map<string, FrozenPtySession>()
  const requests: Array<{ argv: readonly string[]; cwd: string }> = []
  let failSpawn = false
  const driver: PtyDriver = (request) => {
    if (failSpawn) {
      failSpawn = false
      throw new Error("spawn denied")
    }
    requests.push({ argv: request.argv, cwd: request.cwd })
    const child = new FakeChild(request.onData)
    children.push(child)
    return child as unknown as PtyChild
  }
  const freeze: PtyFreezeSink = {
    save: (record) => saved.set(record.key, record),
    drop: (key) => saved.delete(key),
  }
  return {
    children,
    saved,
    requests,
    failNextSpawn: () => {
      failSpawn = true
    },
    host: new PtyHost({ driver, freeze }),
  }
}

const TOKEN = {}
const SINK = () => {}
const SPEC = { cwd: "/wt/t1", command: ["/bin/cat"], cols: 80, rows: 24 }

function replayText(replay: string): string {
  return Buffer.from(replay, "base64").toString("utf8")
}

describe("PtyHost freeze/restore", () => {
  it("freezes live output (throttled), on exit, and on flushFrozen", () => {
    const h = harness()
    h.host.open("t1::tab-1", SPEC, TOKEN, SINK)
    h.children[0].write("one")
    expect(h.saved.get("t1::tab-1")).toBeDefined()
    const first = h.saved.get("t1::tab-1")
    expect(replayText(first?.ringB64 ?? "")).toContain("one")

    // Inside the throttle window a second chunk marks drift but does not write.
    h.children[0].write("two")
    expect(replayText(h.saved.get("t1::tab-1")?.ringB64 ?? "")).not.toContain("two")

    h.host.flushFrozen()
    expect(replayText(h.saved.get("t1::tab-1")?.ringB64 ?? "")).toContain("two")
  })

  it("a thawed corpse respawns IN PLACE on open: ring kept, caller spec wins", () => {
    const h = harness()
    h.host.open("t1::tab-1", SPEC, TOKEN, SINK)
    h.children[0].write("before-restart")
    h.host.flushFrozen()

    const h2 = harness()
    expect(h2.host.restoreFrozen([freezeOf(h.saved, "t1::tab-1")])).toBe(1)
    const row = h2.host.list().find((s) => s.key === "t1::tab-1")
    expect(row).toMatchObject({ alive: false, restored: true })

    // The TUI's dead-reattach passes its resume launch as the open spec.
    const resumeSpec = { cwd: "/wt/t1", command: ["/bin/zsh", "-ilc", "claude --resume abc"] }
    const res = h2.host.open("t1::tab-1", resumeSpec, {}, () => {})
    expect(res).toMatchObject({ alive: true, created: false, respawned: true })
    expect(replayText(res.replay)).toContain("before-restart")
    expect(h2.requests[0].argv).toEqual(resumeSpec.command)
    expect(h2.host.list()[0]).toMatchObject({ alive: true, restored: undefined })

    // The respawned child is a working session, and totalBytes continues.
    h2.children[0].write("after")
    expect(h2.host.peek("t1::tab-1").offset).toBeGreaterThan(res.offset)
  })

  it("respawn falls back to the FROZEN command when the open spec carries none", () => {
    const h = harness()
    h.host.open("t1::tab-1", SPEC, TOKEN, SINK)
    h.host.flushFrozen()
    const h2 = harness()
    h2.host.restoreFrozen([h.saved.get("t1::tab-1")!])
    const res = h2.host.open("t1::tab-1", { cwd: "/wt/t1" }, {}, () => {})
    expect(res.respawned).toBe(true)
    expect(h2.requests[0].argv).toEqual(["/bin/cat"])
  })

  it("a failed respawn degrades to an ordinary view-only corpse (no retry loop)", () => {
    const h = harness()
    h.host.open("t1::tab-1", SPEC, TOKEN, SINK)
    h.children[0].write("last words")
    h.host.flushFrozen()
    const h2 = harness()
    h2.host.restoreFrozen([h.saved.get("t1::tab-1")!])
    h2.failNextSpawn()
    const res = h2.host.open("t1::tab-1", SPEC, {}, () => {})
    expect(res).toMatchObject({ alive: false, created: false, respawned: false })
    expect(replayText(res.replay)).toContain("last words")
    expect(h2.host.list()[0]).toMatchObject({ alive: false, restored: undefined })
  })

  it("an ordinary (non-restored) corpse never respawns on open", async () => {
    const h = harness()
    h.host.open("t1::tab-1", SPEC, TOKEN, SINK)
    h.children[0].write("bye")
    h.children[0].exit(1)
    await new Promise((r) => setTimeout(r, 0)) // let the exited promise settle
    const res = h.host.open("t1::tab-1", SPEC, {}, () => {})
    expect(res).toMatchObject({ alive: false, respawned: false })
    expect(h.children.length).toBe(1) // no new child
  })

  it("exit freezes the final state (exit record included); kill DROPS the record", async () => {
    const h = harness()
    h.host.open("t1::tab-1", SPEC, TOKEN, SINK)
    h.children[0].write("dying words")
    h.children[0].exit(3)
    await new Promise((r) => setTimeout(r, 0))
    const record = h.saved.get("t1::tab-1")
    expect(record?.exit).toMatchObject({ code: 3 })
    expect(replayText(record?.ringB64 ?? "")).toContain("dying words")

    await h.host.kill("t1::tab-1")
    expect(h.saved.has("t1::tab-1")).toBe(false)
  })

  it("shutdown freezes everything but keeps the records (host restart ≠ close)", async () => {
    const h = harness()
    h.host.open("t1::tab-1", SPEC, TOKEN, SINK)
    h.children[0].write("work")
    await h.host.shutdown()
    expect(h.saved.has("t1::tab-1")).toBe(true)
    expect(h.children[0].killed.length).toBeGreaterThan(0)
  })

  it("the warm spare never freezes (internal key)", () => {
    const h = harness()
    h.host.warm("/wt/t1", "/bin/zsh")
    h.host.flushFrozen()
    expect([...h.saved.keys()].every((k) => !k.startsWith("::"))).toBe(true)
  })
})

/** Re-read helper kept separate so the respawn test reads linearly. */
function freezeOf(saved: Map<string, FrozenPtySession>, key: string): FrozenPtySession {
  const record = saved.get(key)
  if (!record) throw new Error(`no frozen record for ${key}`)
  return record
}
