import { unlink } from "node:fs/promises"
import { KobeDaemonClient } from "../client/index.ts"
import { readPidFile } from "./server.ts"

export type DaemonStopMethod = "absent" | "graceful" | "sigterm" | "sigkill"

export interface StopDaemonResult {
  pid: number | null
  method: DaemonStopMethod
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

export async function stopDaemonProcess(socketPath: string, pidPath: string): Promise<StopDaemonResult> {
  const oldPid = await readPidFile(pidPath)
  const targetPid = oldPid !== null && oldPid !== process.pid ? oldPid : null
  const wasAlive = targetPid !== null && isProcessAlive(targetPid)
  let method: DaemonStopMethod = wasAlive ? "graceful" : "absent"

  const client = new KobeDaemonClient(socketPath)
  const stopRequest = client.request("daemon.stop").catch(() => undefined)
  const stopTimeout = new Promise<void>((resolve) => setTimeout(resolve, 2000))
  await Promise.race([stopRequest, stopTimeout])
  client.close()

  if (wasAlive && targetPid !== null) {
    const deadline = Date.now() + 5000
    let escalated = false
    while (Date.now() < deadline) {
      try {
        process.kill(targetPid, 0)
      } catch {
        break
      }
      if (!escalated && Date.now() - (deadline - 5000) > 2000) {
        try {
          process.kill(targetPid, "SIGTERM")
        } catch {}
        method = "sigterm"
        escalated = true
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    try {
      process.kill(targetPid, 0)
      process.kill(targetPid, "SIGKILL")
      method = "sigkill"
      await new Promise((resolve) => setTimeout(resolve, 100))
    } catch {}
  }

  await unlink(socketPath).catch(() => {})
  await unlink(pidPath).catch(() => {})
  return { pid: oldPid, method }
}
