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

async function until(cond: () => boolean, label: string, ms = 5000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timeout: ${label}`)
    await new Promise((r) => setTimeout(r, 30))
  }
}

const OPTS = { cwd: dir, command: ["/bin/cat"], cols: 60, rows: 12 }

describe("HostedTaskPty over a real pty-host socket", () => {
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

  test("same-size reattach to a live session forces a repaint wiggle (SIGWINCH)", async () => {
    // A full-screen app repaints only on SIGWINCH; a same-size reattach
    // used to raise none, leaving the replayed screen stale forever (the
    // restart / park-wake "UI is gone" bug). The trap stands in for the
    // app's repaint handler.
    const cmd = ["/bin/sh", "-c", 'trap "echo REPAINT" WINCH; echo ready; while :; do sleep 0.1; done']
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
