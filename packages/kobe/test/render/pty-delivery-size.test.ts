/**
 * Issue #18 — `kobe api send` delivery must not resize the pane's PTY.
 *
 * The attached TUI opens a session at its real pane size; a headless
 * delivery client used to reattach via `pty.open {cols:80, rows:24}`,
 * which the host treats as last-attach-wins → the engine got SIGWINCH,
 * repainted at 80 cols, and the pane garbled (content wrapped into the
 * left half, right half blank). The anchored property: after a delivery,
 * the child's terminal size still equals the attached client's pane size.
 *
 * Runs against a real Bun PTY child (`/bin/sh`, probed with `stty size`),
 * like pty-host.test.ts — the spawn/terminal plumbing is production's.
 */

import { afterEach, describe, expect, test } from "bun:test"
import type { DaemonFrame } from "@sma1lboy/kobe-daemon/daemon/protocol"
import { PtyHost } from "@sma1lboy/kobe-daemon/daemon/pty-host"
import { type HostedSessionRpc, deliverToHostedKey } from "../../src/engine/hosted-session.ts"

const hosts: PtyHost[] = []

function makeHost(): PtyHost {
  const host = new PtyHost({})
  hosts.push(host)
  return host
}

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.killAll()))
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

async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** The host wrapped as the delivery client's rpc — anything beyond
 *  peek/write throws, so delivery attaching or resizing fails the test. */
function deliveryRpc(host: PtyHost): HostedSessionRpc {
  return {
    request: async <T>(name: string, payload?: unknown): Promise<T> => {
      const p = payload as { key: string; data?: string }
      if (name === "pty.peek") return host.peek(p.key) as T
      if (name === "pty.write") {
        host.write(p.key, p.data ?? "")
        return {} as T
      }
      throw new Error(`delivery used forbidden rpc: ${name}`)
    },
  }
}

describe("prompt delivery vs pane size (issue #18)", () => {
  test("after a peer delivery, the PTY still has the attached pane's size", async () => {
    const host = makeHost()
    const { frames, sink } = collector()
    // The TUI: attached at its real pane size (deliberately NOT 80×24).
    const open = host.open("t1::tab-1", { cwd: process.cwd(), command: ["/bin/sh"], cols: 120, rows: 10 }, {}, sink)
    expect(open.alive).toBe(true)

    // A peer `kobe api send` lands through the real delivery helper.
    const delivered = await deliverToHostedKey(deliveryRpc(host), "t1::tab-1", "true")
    expect(delivered).toBe(true)
    // The bracketed-pasted prompt reached the child (pty echoes it back).
    await until(() => dataText(frames).includes("true"))

    // The pane-width anchor: the child's terminal size is unchanged.
    host.write("t1::tab-1", "stty size\n")
    await until(() => dataText(frames).includes("10 120"))
    expect(dataText(frames)).not.toInclude("24 80")
  })

  test("delivery into a dead session is refused without writing", async () => {
    const host = makeHost()
    const { sink } = collector()
    host.open("t1::tab-1", { cwd: process.cwd(), command: ["/bin/sh"], cols: 120, rows: 10 }, {}, sink)
    host.write("t1::tab-1", "exit\n")
    await until(() => host.peek("t1::tab-1").alive === false)
    expect(await deliverToHostedKey(deliveryRpc(host), "t1::tab-1", "true")).toBe(false)
  })

  test("a SIZED reattach still resizes (tmux last-attach-wins is preserved)", async () => {
    const host = makeHost()
    const a = collector()
    host.open("t1::tab-1", { cwd: process.cwd(), command: ["/bin/sh"], cols: 120, rows: 10 }, {}, a.sink)
    // A second TUI attaches at a different real size — that must keep working.
    const b = collector()
    host.open("t1::tab-1", { cwd: process.cwd(), cols: 90, rows: 20 }, { other: true }, b.sink)
    host.write("t1::tab-1", "stty size\n")
    await until(() => dataText(b.frames).includes("20 90"))
  })
})
