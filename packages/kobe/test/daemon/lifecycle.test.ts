import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { stopDaemonProcess } from "../../src/daemon/lifecycle.ts"

/**
 * `stopDaemonProcess` is the shared kill primitive behind `kobe daemon
 * restart` and `kobe reset` (KOB-258). These cover the two paths that are
 * deterministic without a live wedged daemon: nothing running (idempotent
 * cleanup) and a pidfile pointing at an already-dead process. The
 * SIGTERM→SIGKILL escalation is inherited verbatim from the long-proven
 * restart path, so it isn't re-exercised here (it needs a live process
 * that ignores SIGTERM, which is inherently flaky to stage).
 */
describe("stopDaemonProcess", () => {
  let dir: string
  let socketPath: string
  let pidPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kobe-lifecycle-"))
    socketPath = join(dir, "daemon.sock")
    pidPath = join(dir, "daemon.pid")
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("reports absent and is a no-op when nothing is running", async () => {
    const result = await stopDaemonProcess(socketPath, pidPath)
    expect(result).toEqual({ pid: null, method: "absent" })
  })

  it("removes a stale socket file even with no pidfile", async () => {
    writeFileSync(socketPath, "") // orphan socket file left by a SIGKILLed daemon
    const result = await stopDaemonProcess(socketPath, pidPath)
    expect(result.method).toBe("absent")
    expect(existsSync(socketPath)).toBe(false)
  })

  it("clears a pidfile that points at a dead process", async () => {
    // Spawn then immediately kill a child to obtain a guaranteed-dead pid
    // (a made-up pid would race a real process in CI). Use node's spawn —
    // vitest runs under Node, where `Bun` is undefined.
    const child = spawn("sleep", ["30"], { stdio: "ignore" })
    const deadPid = child.pid as number
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
      child.kill("SIGKILL")
    })

    writeFileSync(pidPath, `${deadPid}\n`)
    const result = await stopDaemonProcess(socketPath, pidPath)

    expect(result.pid).toBe(deadPid)
    // Already gone, so no signal was needed beyond the graceful ask.
    expect(result.method).toBe("graceful")
    expect(existsSync(pidPath)).toBe(false)
  })

  it("ignores a non-numeric pidfile", async () => {
    writeFileSync(pidPath, "not-a-pid\n")
    const result = await stopDaemonProcess(socketPath, pidPath)
    expect(result.pid).toBeNull()
    expect(result.method).toBe("absent")
  })
})
