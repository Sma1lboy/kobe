/**
 * End-to-end: real pty-host server + real HostedTaskPty over the unix
 * socket. This is the persistence contract users feel: quit the TUI
 * (detach) → the engine keeps running in the host; reopen → the screen
 * replays; only kill() ends the remote child. The daemon is deliberately
 * absent — the pty host is its own process precisely so daemon restarts
 * can't touch sessions.
 *
 * Lives in test/render (the bun-test-only track) although it renders
 * nothing: the host spawns via `Bun.spawn(..., { terminal })`, which
 * needs the BUN runtime; the vitest pools run under Node.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import { type PtyHostServer, startPtyHostServer } from "@sma1lboy/kobe-daemon/daemon/pty-server"
import { HostedTaskPty } from "../../src/tui/panes/terminal/pty-hosted.ts"

const dir = mkdtempSync(join(tmpdir(), "kobe-pty-hosted-"))
let server: PtyHostServer

beforeAll(async () => {
  process.env.KOBE_PTY_SOCKET_PATH = join(dir, "pty.sock")
  process.env.KOBE_PTY_PID_PATH = join(dir, "pty.pid")
  // The server is already listening, so ensurePtyHostReachable's probe
  // succeeds and never spawns a detached `kobe pty-host`.
  server = await startPtyHostServer({
    socketPath: process.env.KOBE_PTY_SOCKET_PATH,
    pidPath: process.env.KOBE_PTY_PID_PATH,
    idleExitMs: 60_000,
  })
})

afterAll(async () => {
  await server.close()
  Reflect.deleteProperty(process.env, "KOBE_PTY_SOCKET_PATH")
  Reflect.deleteProperty(process.env, "KOBE_PTY_PID_PATH")
})

function text(pty: HostedTaskPty): string {
  return pty
    .capture()
    .map((row) => row.map((c) => c.text).join(""))
    .join("\n")
}

class DelayedRepaintPty extends HostedTaskPty {
  readonly repaintWaits: number[] = []
  readonly resizeTimes: number[] = []
  repaintObservedAt: number | null = null

  protected override sendResize(cols: number, rows: number): void {
    this.resizeTimes.push(Date.now())
    super.sendResize(cols, rows)
  }

  protected override nextDataOrTimeout(ms: number): Promise<void> {
    this.repaintWaits.push(ms)
    return new Promise((resolve) => {
      setTimeout(() => {
        this.repaintObservedAt = Date.now()
        resolve()
      }, 300)
    })
  }
}

async function until(cond: () => boolean, label: string, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 30))
  }
}

const OPTS = { cwd: dir, command: ["/bin/cat"], cols: 60, rows: 12 }

describe("HostedTaskPty over a real pty-host socket", () => {
  test("a second host refuses to replace a live host socket", async () => {
    const socketPath = join(dir, "singleton.sock")
    const pidPath = join(dir, "singleton.pid")
    const first = await startPtyHostServer({ socketPath, pidPath, idleExitMs: 60_000 })
    const secondAttempt = startPtyHostServer({ socketPath, pidPath, idleExitMs: 60_000 })
    try {
      await expect(secondAttempt).rejects.toThrow()

      const client = new KobeDaemonClient(socketPath)
      try {
        await client.connect()
        const hello = await client.request<{ pid: number }>("hello", {})
        expect(hello.pid).toBe(process.pid)
      } finally {
        client.close()
      }
    } finally {
      const second = await secondAttempt.catch(() => null)
      await second?.close()
      await first.close()
    }
  })

  test("detach survives, reattach replays, kill ends the child", async () => {
    // Attach #1: live stream.
    const a = new HostedTaskPty({ taskId: "smoke::t1", ...OPTS })
    a.write("persist-me\n")
    await until(() => text(a).includes("persist-me"), "first attach sees output")

    // TUI quit: detach — the child must keep running in the host.
    a.detach()
    expect(a.killed).toBe(true)

    // Attach #2 (fresh TUI): the ring-buffer replay repaints the screen,
    // and the session is still interactive.
    const b = new HostedTaskPty({ taskId: "smoke::t1", ...OPTS })
    await until(() => text(b).includes("persist-me"), "reattach replays scrollback")
    b.write("after-reattach\n")
    await until(() => text(b).includes("after-reattach"), "reattached session interactive")

    // kill() ends the REMOTE child: the next open spawns fresh (a child
    // that prints then parks, so the exit race can't eat the output).
    b.kill()
    await new Promise((r) => setTimeout(r, 200))
    const c = new HostedTaskPty({
      taskId: "smoke::t1",
      cwd: dir,
      command: ["/bin/sh", "-c", "echo fresh; sleep 30"],
      cols: 60,
      rows: 12,
    })
    await until(() => text(c).includes("fresh") && !text(c).includes("persist-me"), "fresh session after kill")
    c.kill()
  })

  test("kill() + immediate same-key reopen survives the old child's exit frame", async () => {
    // The editor-tab file swap (and F5 reset): release the old vim and
    // acquire a new PTY under the SAME key in the same tick. The host's
    // pty.exit for the OLD child races the new handle's open over the
    // key-routed dispatcher — pre-fix it marked the NEW handle dead, so
    // the tab closed itself and the file needed a second click.
    const a = new HostedTaskPty({ taskId: "smoke::t7", ...OPTS })
    a.write("old-file\n")
    await until(() => text(a).includes("old-file"), "first session streams")
    a.kill()
    // No settle delay — provoking the race is the point.
    const b = new HostedTaskPty({
      taskId: "smoke::t7",
      cwd: dir,
      command: ["/bin/sh", "-c", "echo new-file; sleep 30"],
      cols: 60,
      rows: 12,
    })
    await until(() => text(b).includes("new-file"), "respawned session streams")
    // Let the old incarnation's exit frame land — it must not kill us.
    await new Promise((r) => setTimeout(r, 300))
    expect(b.killed).toBe(false)
    expect(b.deadOnAttach).toBe(false)
    b.kill()
  })

  test("same-size reattach to a live session forces a repaint wiggle (SIGWINCH)", async () => {
    // A full-screen app repaints only when a SIGWINCH delivers a size that
    // actually CHANGED (claude's behavior) — the trap mimics that. Two
    // regressions guarded here: a same-size reattach that raises no
    // SIGWINCH at all (the restart "UI is gone" bug), and a zero-gap
    // shrink+restore wiggle whose signals COALESCE into one delivery at
    // the unchanged final size, which such an app ignores (measured: two
    // back-to-back resizes → one SIGWINCH at the original size).
    const cmd = [
      "/bin/sh",
      "-c",
      'cur=$(stty size); trap \'new=$(stty size); if [ "$new" != "$cur" ]; then cur=$new; echo REPAINT; fi\' WINCH; echo ready; while :; do sleep 0.1; done',
    ]
    const a = new HostedTaskPty({ taskId: "smoke::t3", cwd: dir, command: cmd, cols: 60, rows: 12 })
    await until(() => text(a).includes("ready"), "first attach sees output")
    // Fresh spawn (empty replay) must NOT wiggle — nothing to repaint.
    expect(text(a).includes("REPAINT")).toBe(false)
    a.detach()

    const b = new HostedTaskPty({ taskId: "smoke::t3", cwd: dir, command: cmd, cols: 60, rows: 12 })
    await until(() => text(b).includes("REPAINT"), "same-size reattach wiggles a SIGWINCH out of the child")
    expect(b.deadOnAttach).toBe(false)
    b.kill()
  })

  test("waits 500ms for a delayed repaint before restoring the reattach size", async () => {
    // Regression for 052e57e: a macOS repaint can arrive after the old
    // 200ms bound. This deterministic delayed-repaint handle holds the
    // shrink stage for 300ms, so the test both pins the 500ms contract and
    // proves the original size is restored only after that repaint settles.
    const a = new HostedTaskPty({ taskId: "smoke::t3-delayed", ...OPTS })
    a.write("ready\n")
    await until(() => text(a).includes("ready"), "first delayed-repaint attach sees output")
    a.detach()

    const b = new DelayedRepaintPty({ taskId: "smoke::t3-delayed", ...OPTS })
    await until(() => b.resizeTimes.length === 2, "delayed repaint settles before the size restore")
    expect(b.repaintWaits).toEqual([500])
    const repaintObservedAt = b.repaintObservedAt
    expect(repaintObservedAt).not.toBeNull()
    expect(b.resizeTimes[1]).toBeGreaterThanOrEqual(repaintObservedAt!)
    b.kill()
  })

  test("a second viewer on the same key doesn't steal the stream, and its detach doesn't starve the first", async () => {
    // Regression (0.7.86 O(1) dispatch): the key→handle map was single-slot,
    // so a second attach silently replaced the first handle's route — the
    // first pane froze on its last frame while the child kept streaming.
    const OPTS6 = { cwd: dir, command: ["/bin/cat"], cols: 60, rows: 12 }
    const a = new HostedTaskPty({ taskId: "smoke::t6", ...OPTS6 })
    a.write("first\n")
    await until(() => text(a).includes("first"), "A streams")

    const b = new HostedTaskPty({ taskId: "smoke::t6", ...OPTS6 })
    await until(() => text(b).includes("first"), "B replays the ring buffer")
    b.write("both-see-this\n")
    await until(() => text(b).includes("both-see-this"), "B streams")
    await until(() => text(a).includes("both-see-this"), "A KEEPS streaming after B attached")

    // Parking B must not starve A: a sibling is still attached, so the
    // shared per-connection host sink has to survive B's detach.
    b.detach()
    a.write("after-b-detach\n")
    await until(() => text(a).includes("after-b-detach"), "A still streams after B detached")
    a.kill()
  })

  test("attaching to an already-exited session flags deadOnAttach", async () => {
    // Engine died while no TUI was attached — the host keeps the corpse.
    const a = new HostedTaskPty({
      taskId: "smoke::t4",
      cwd: dir,
      command: ["/bin/sh", "-c", "echo bye"],
      cols: 60,
      rows: 12,
    })
    await until(() => a.killed, "self-exited child marks the handle dead")
    // A LIVE-observed exit is not a corpse attach.
    expect(a.deadOnAttach).toBe(false)

    // Reattach (fresh TUI): dead session + non-empty replay → corpse.
    const b = new HostedTaskPty({
      taskId: "smoke::t4",
      cwd: dir,
      command: ["/bin/sh", "-c", "echo bye"],
      cols: 60,
      rows: 12,
    })
    await until(() => b.killed, "corpse reattach marks the handle dead")
    expect(b.deadOnAttach).toBe(true)
    b.kill()

    // A FAILED fresh spawn (empty replay) is not a corpse either — the
    // tab layer must degrade, not loop resume attempts on it.
    const c = new HostedTaskPty({
      taskId: "smoke::t5",
      cwd: dir,
      command: ["/nonexistent-kobe-binary"],
      cols: 60,
      rows: 12,
    })
    await until(() => c.killed, "failed spawn marks the handle dead")
    expect(c.deadOnAttach).toBe(false)
    c.kill()
  })

  test("park + wake restores the exact screen: serialize at park, only the delta replayed (issue #29)", async () => {
    // A sibling handle that never detaches is the oracle: after the parked
    // handle wakes, its screen must be BYTE-IDENTICAL to the sibling's —
    // the contract that made re-enabling the auto-park sweep safe.
    const key = "smoke::park1"
    const OPTS_P = { cwd: dir, command: ["/bin/cat"], cols: 60, rows: 12, scrollback: 200 }
    const parkee = new HostedTaskPty({ taskId: key, ...OPTS_P })
    const oracle = new HostedTaskPty({ taskId: key, ...OPTS_P })
    for (let i = 0; i < 60; i++) parkee.write(`\x1b[3${(i % 6) + 1}mpre-park line ${i}\x1b[0m\n`)
    parkee.write("PRE-PARK-END\n")
    await until(() => text(parkee).includes("PRE-PARK-END"), "parkee sees pre-park content")
    await until(() => text(oracle).includes("PRE-PARK-END"), "oracle sees pre-park content")

    const screen = parkee.capturePark()
    expect(screen).not.toBeNull()
    parkee.detach()

    // Output produced WHILE parked — only these bytes may be replayed.
    oracle.write("while-parked output\n")
    oracle.write("WAKE-MARKER\n")
    await until(() => text(oracle).includes("WAKE-MARKER"), "oracle sees while-parked output")

    const woken = new HostedTaskPty({ taskId: key, ...OPTS_P, restore: screen ?? undefined })
    await until(() => text(woken).includes("WAKE-MARKER"), "woken handle sees the while-parked delta")
    // Full-screen equality against the never-parked oracle — scrollback,
    // colors, and the pre-park content the 512KB-ring path used to lose.
    expect(text(woken)).toBe(text(oracle))
    expect(text(woken)).toContain("pre-park line 0")
    expect(woken.captureCursor()).toEqual(oracle.captureCursor())
    woken.write("interactive-after-wake\n")
    await until(() => text(woken).includes("interactive-after-wake"), "woken session stays interactive")
    oracle.kill()
  })

  test("a stale park state (respawned key) degrades to the full replay, losing nothing", async () => {
    const key = "smoke::park2"
    const OPTS_P = { cwd: dir, command: ["/bin/cat"], cols: 60, rows: 12, scrollback: 200 }
    const a = new HostedTaskPty({ taskId: key, ...OPTS_P })
    a.write("first-incarnation\n")
    await until(() => text(a).includes("first-incarnation"), "first incarnation streams")
    const stale = a.capturePark()
    expect(stale).not.toBeNull()
    a.kill()
    await new Promise((r) => setTimeout(r, 200))

    // Same key, NEW child: the host's pid check must refuse the delta and
    // hand back the full ring, so the fresh session's history survives the
    // discarded restore.
    const b = new HostedTaskPty({ taskId: key, ...OPTS_P, restore: stale ?? undefined })
    b.write("second-incarnation\n")
    await until(() => text(b).includes("second-incarnation"), "respawned session streams")
    expect(text(b)).not.toContain("first-incarnation")
    b.kill()
  })

  test("kill() on a self-exited session forgets the host record — reopen spawns fresh", async () => {
    // The engine-degrade path: the child exits on its own (claude/codex
    // quit), so the handle is already dead when the registry release()s it.
    const a = new HostedTaskPty({
      taskId: "smoke::t2",
      cwd: dir,
      command: ["/bin/sh", "-c", "echo engine-died"],
      cols: 60,
      rows: 12,
    })
    await until(() => a.killed, "self-exited child marks the handle dead")
    a.kill()

    // The degraded tab reopens the SAME key with a different command (the
    // user's shell). The host must spawn it — not hand back the corpse.
    const b = new HostedTaskPty({
      taskId: "smoke::t2",
      cwd: dir,
      command: ["/bin/sh", "-c", "echo fresh-shell; sleep 30"],
      cols: 60,
      rows: 12,
    })
    await until(() => text(b).includes("fresh-shell"), "reopen after dead-handle kill spawns the new command")
    expect(b.killed).toBe(false)
    b.kill()
  })
})
