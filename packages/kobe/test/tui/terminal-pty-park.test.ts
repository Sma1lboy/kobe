/**
 * PTY parking (issue #28) — the registry's idle sweep.
 *
 * Why this matters: every open tab used to keep a full @xterm/headless
 * instance (grid + scrollback) resident forever — the workspace host sat
 * at 250-300MB and was the first process killed under memory pressure.
 * The sweep detaches persistent-backend handles that have had no data
 * subscriber for the idle window; the child keeps running in the pty
 * host, and re-acquire reattaches + replays the host ring buffer (the
 * exact TUI-restart path), so revived content matches what a restart
 * would show. These tests pin who may be parked and who must never be:
 * subscribed (visible) panes, non-persistent backends, and young idlers
 * all survive.
 */

import { describe, expect, it } from "vitest"
import { MockTaskPty } from "../../src/tui/panes/terminal/pty-mock"
import type { ParkedScreen, TaskPtyOpts } from "../../src/tui/panes/terminal/pty-types"
import { XtermTaskPty } from "../../src/tui/panes/terminal/pty-xterm-base"
import { PtyRegistry } from "../../src/tui/panes/terminal/registry"

/** Persistent-backend stand-in: detachable, with the real unwatched clock. */
class ParkableFakePty extends MockTaskPty {
  detached = false
  private unwatchedSince: number | null
  /** Test seam: park-state capture, overridden per test. */
  capturePark: (() => ParkedScreen | null) | undefined

  constructor(opts: TaskPtyOpts, unwatchedSince: number | null) {
    super(opts)
    this.unwatchedSince = unwatchedSince
  }

  detach(): void {
    this.detached = true
  }

  unwatchedSinceMs(): number | null {
    return this.unwatchedSince
  }
}

describe("PtyRegistry.parkIdle", () => {
  const NOW = 1_000_000
  const IDLE = 120_000

  it("parks an unwatched persistent handle past the idle window (detach, not kill)", () => {
    let fake: ParkableFakePty | undefined
    const reg = new PtyRegistry((opts) => {
      fake = new ParkableFakePty(opts, NOW - IDLE - 1)
      return fake
    })
    reg.acquire("t::tab-1", "/wt")
    expect(reg.parkIdle(IDLE, NOW)).toEqual(["t::tab-1"])
    expect(fake?.detached).toBe(true)
    expect(fake?.killed).toBe(false) // the child keeps running in the host
    expect(reg.has("t::tab-1")).toBe(false)
  })

  it("never parks a watched handle (visible pane) or a young idler", () => {
    const fakes: ParkableFakePty[] = []
    const reg = new PtyRegistry((opts) => {
      // watched (null) for tab-1, hidden-but-young for tab-2
      const fake = new ParkableFakePty(opts, fakes.length === 0 ? null : NOW - IDLE + 5_000)
      fakes.push(fake)
      return fake
    })
    reg.acquire("t::tab-1", "/wt")
    reg.acquire("t::tab-2", "/wt")
    expect(reg.parkIdle(IDLE, NOW)).toEqual([])
    expect(fakes.every((f) => !f.detached)).toBe(true)
    expect(reg.size).toBe(2)
  })

  it("never parks a non-persistent backend (no detach — dropping it would kill the shell)", () => {
    const reg = new PtyRegistry((opts) => new MockTaskPty(opts))
    reg.acquire("t::tab-1", "/wt")
    expect(reg.parkIdle(0, NOW)).toEqual([])
    expect(reg.size).toBe(1)
  })

  it("re-acquire after parking hands back a fresh handle under the same key (the wake path)", () => {
    const made: ParkableFakePty[] = []
    const reg = new PtyRegistry((opts) => {
      const fake = new ParkableFakePty(opts, NOW - IDLE - 1)
      made.push(fake)
      return fake
    })
    const parked = reg.acquire("t::tab-1", "/wt")
    reg.parkIdle(IDLE, NOW)
    const woken = reg.acquire("t::tab-1", "/wt")
    expect(woken).not.toBe(parked)
    expect(made).toHaveLength(2)
    expect(reg.get("t::tab-1")).toBe(woken)
  })

  it("carries the parked screen into the wake acquire exactly once (issue #29)", () => {
    const SCREEN: ParkedScreen = {
      serialized: "\x1b[1mparked\x1b[0m",
      title: "vim",
      cursorHidden: false,
      cols: 60,
      rows: 12,
      byteOffset: 4096,
      pid: 123,
    }
    const seen: (ParkedScreen | undefined)[] = []
    const reg = new PtyRegistry((opts) => {
      seen.push(opts.restore)
      const fake = new ParkableFakePty(opts, NOW - IDLE - 1)
      fake.capturePark = () => SCREEN
      return fake
    })
    reg.acquire("t::tab-1", "/wt")
    expect(reg.parkIdle(IDLE, NOW)).toEqual(["t::tab-1"])

    reg.acquire("t::tab-1", "/wt") // wake — restore rides along
    reg.parkIdle(IDLE, NOW)
    reg.acquire("t::tab-1", "/wt") // second wake — captured again, not reused
    expect(seen.map((s) => s?.byteOffset)).toEqual([undefined, 4096, 4096])
    expect(seen[1]).toBe(SCREEN)
  })

  it("release/releaseWhere drop a parked screen so the next session never restores a dead one", () => {
    const seen: (object | undefined)[] = []
    const reg = new PtyRegistry((opts) => {
      seen.push(opts.restore)
      const fake = new ParkableFakePty(opts, NOW - IDLE - 1)
      fake.capturePark = () => ({
        serialized: "x",
        title: null,
        cursorHidden: false,
        cols: 1,
        rows: 1,
        byteOffset: 1,
        pid: 1,
      })
      return fake
    })
    reg.acquire("t::tab-1", "/wt")
    reg.parkIdle(IDLE, NOW)
    reg.release("t::tab-1")
    reg.acquire("t::tab-1", "/wt")
    expect(seen[1]).toBeUndefined()

    reg.parkIdle(IDLE, NOW)
    reg.releaseWhere((id) => id.startsWith("t::"))
    reg.acquire("t::tab-1", "/wt")
    expect(seen[2]).toBeUndefined()
  })
})

/** The real unwatched clock on the shared xterm base. */
class FakeTransportPty extends XtermTaskPty {
  protected transportWrite(_data: string): void {}
  protected transportResize(_cols: number, _rows: number): void {}
  protected transportKill(): void {}
}

describe("XtermTaskPty.unwatchedSinceMs", () => {
  it("fresh instance ages toward the sweep; subscribe clears; last unsubscribe restarts the clock", () => {
    const pty = new FakeTransportPty({ taskId: "t", cwd: "/" })
    expect(pty.unwatchedSinceMs()).not.toBeNull()

    const offA = pty.onData(() => {})
    const offB = pty.onData(() => {})
    expect(pty.unwatchedSinceMs()).toBeNull()

    offA()
    expect(pty.unwatchedSinceMs()).toBeNull() // one subscriber remains
    offB()
    expect(pty.unwatchedSinceMs()).not.toBeNull()

    pty.onData(() => {})
    expect(pty.unwatchedSinceMs()).toBeNull() // resubscribe protects again
    pty.kill()
  })
})
