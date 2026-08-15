/**
 * Freeze/restore against REAL PTY children (`/bin/cat` echo) and the REAL
 * per-session file store — the end-to-end half of the contract the fake
 * driver tests in test/daemon can't cover: a thawed session's respawn must
 * produce a working terminal, and the replay must be the pre-restart bytes.
 *
 * Lives in test/render (the bun-test track) for the same reason as
 * pty-host.test.ts: `Bun.spawn(..., { terminal })` needs the Bun runtime.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DaemonFrame } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { fileFreezeSink, loadFrozenSessions } from "@sma1lboy/kobe-daemon/daemon/pty-freeze-store"
import { PtyHost } from "@sma1lboy/kobe-daemon/daemon/pty-host"

const hosts: PtyHost[] = []
const dirs: string[] = []

function makeHost(opts: ConstructorParameters<typeof PtyHost>[0] = {}): PtyHost {
  const host = new PtyHost(opts)
  hosts.push(host)
  return host
}

function makeFreezeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "kobe-pty-freeze-bun-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.killAll()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function collector(): { frames: DaemonFrame[]; sink: (frame: DaemonFrame) => void } {
  const frames: DaemonFrame[] = []
  return { frames, sink: (frame) => frames.push(frame) }
}

function dataText(frames: DaemonFrame[]): string {
  let out = ""
  for (const frame of frames) {
    if (frame.type === "event" && frame.name === "pty.data") {
      out += Buffer.from((frame.payload as { data: string }).data, "base64").toString("utf8")
    }
  }
  return out
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 20))
  }
}

const SPEC = { cwd: process.cwd(), command: ["/bin/cat"], cols: 40, rows: 10 }

describe("PtyHost freeze/restore with real PTYs", () => {
  test("a host restart restores the session: scrollback replays, the respawned child works", async () => {
    const freezeDir = makeFreezeDir()
    const hostA = makeHost({ freeze: fileFreezeSink(freezeDir) })
    const first = collector()
    hostA.open("t1::tab-1", SPEC, {}, first.sink)
    hostA.write("t1::tab-1", "before-restart\n")
    await until(() => dataText(first.frames).includes("before-restart"))

    // The host process ends: children are ended, freeze records stay.
    await hostA.shutdown()
    expect(hosts.splice(0).includes(hostA)).toBe(true) // removed so afterEach skips it
    const records = loadFrozenSessions(freezeDir)
    expect(records.map((r) => r.key)).toEqual(["t1::tab-1"])

    // The next host incarnation thaws the record; the first open respawns.
    const hostB = makeHost({ freeze: fileFreezeSink(freezeDir) })
    expect(hostB.restoreFrozen(records)).toBe(1)
    const second = collector()
    const res = hostB.open("t1::tab-1", SPEC, {}, second.sink)
    expect(res).toMatchObject({ alive: true, created: false, respawned: true })
    expect(Buffer.from(res.replay, "base64").toString("utf8")).toContain("before-restart")

    hostB.write("t1::tab-1", "after-restart\n")
    await until(() => dataText(second.frames).includes("after-restart"))
  })
})
