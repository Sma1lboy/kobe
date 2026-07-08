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
