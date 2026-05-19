/**
 * End-to-end smoke test for `TmuxControlClient` against a real
 * `tmux -CC`. Each test spins up a throwaway tmux session via
 * `createIfMissing`, runs one realistic flow, then in `finally` kills
 * the session via the plain CLI so an assertion failure can never
 * leak an orphaned tmux server.
 *
 * Gated on tmux availability — the behavior runner itself is gated
 * on `KOBE_INCLUDE_BEHAVIOR=1`, but `tmux -V` may still be missing
 * on the host (CI, minimal containers). We probe once per file with
 * `tmux -V` and `it.skipIf` each test.
 */

import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, expect, it } from "vitest"
import { type TmuxControlClient, spawnControlClient } from "../../src/tmux/control-client.ts"

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0

let session = ""
let client: TmuxControlClient | null = null

beforeEach(() => {
  const id = Math.random().toString(36).slice(2, 8)
  session = `kobe-test-${id}`
})

afterEach(async () => {
  if (client) {
    try {
      await client.close()
    } catch {
      /* ignore */
    }
    client = null
  }
  // Belt-and-braces: kill the session via the CLI, ignoring failures
  // (test may have already killed it as part of the flow). This
  // guarantees we never leave an orphaned tmux server behind even if
  // the control client itself misbehaved.
  if (session) {
    spawnSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
  }
})

it.skipIf(!tmuxAvailable)(
  "splitWindow against a real session creates a second pane and fires %layout-change",
  async () => {
    client = await spawnControlClient({ session, createIfMissing: true })
    const layoutChanges: unknown[] = []
    client.on("layout-change", (ev) => layoutChanges.push(ev))

    const before = await client.listPanes({ target: session, format: "#{pane_id}" })
    expect(before).toHaveLength(1)

    await client.splitWindow({ target: session, direction: "h" })
    // Allow a beat for tmux to emit the %layout-change notification.
    await new Promise((r) => setTimeout(r, 200))

    const after = await client.listPanes({ target: session, format: "#{pane_id}" })
    expect(after.length).toBeGreaterThanOrEqual(2)
    expect(layoutChanges.length).toBeGreaterThan(0)
  },
  20_000,
)

it.skipIf(!tmuxAvailable)(
  "killing the last pane causes tmux -CC to send %exit and the client to emit close",
  async () => {
    client = await spawnControlClient({ session, createIfMissing: true })
    let closed = false
    client.on("close", () => {
      closed = true
    })
    let sawExit = false
    client.on("exit", () => {
      sawExit = true
    })

    const panes = await client.listPanes({ target: session, format: "#{pane_id}" })
    expect(panes).toHaveLength(1)
    const paneId = panes[0]
    expect(paneId).toMatch(/^%/)

    // killing the only pane kills the window, which kills the session
    // we're attached to, which causes tmux -CC to emit %exit and close
    // the stdout pipe. The kill itself races with the response, so we
    // accept either resolve or reject for the kill-pane call.
    await client.killPane({ target: paneId ?? "" }).catch(() => undefined)
    await new Promise((r) => setTimeout(r, 500))

    expect(closed || sawExit).toBe(true)
  },
  20_000,
)
