import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stopDaemonProcess } from "@sma1lboy/kobe-daemon/daemon/lifecycle"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

type EventedChild = {
  readonly pid?: number
  once(event: "exit", listener: () => void): void
  kill(signal: NodeJS.Signals): boolean
}

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
    writeFileSync(socketPath, "")
    const result = await stopDaemonProcess(socketPath, pidPath)
    expect(result.method).toBe("absent")
    expect(existsSync(socketPath)).toBe(false)
  })

  it("clears a pidfile that points at a dead process", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" }) as unknown as EventedChild
    const deadPid = child.pid as number
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve())
      child.kill("SIGKILL")
    })

    writeFileSync(pidPath, `${deadPid}\n`)
    const result = await stopDaemonProcess(socketPath, pidPath)

    expect(result.pid).toBe(deadPid)
    expect(result.method).toBe("absent")
    expect(existsSync(pidPath)).toBe(false)
  })

  it("ignores a non-numeric pidfile", async () => {
    writeFileSync(pidPath, "not-a-pid\n")
    const result = await stopDaemonProcess(socketPath, pidPath)
    expect(result.pid).toBeNull()
    expect(result.method).toBe("absent")
  })
})
