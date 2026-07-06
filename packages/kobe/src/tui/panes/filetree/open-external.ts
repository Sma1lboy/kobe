import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { platform } from "node:os"
import type { Readable } from "node:stream"

type EventedChild = {
  readonly stdout?: Readable | null
  on(event: "error", listener: (err: Error) => void): void
  on(event: "close", listener: (code: number | null) => void): void
  unref(): void
}

export function openExternally(absPath: string): void {
  if (!absPath) return
  const plat = platform()
  if (plat === "linux") {
    if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") || process.env.WSL_DISTRO_NAME) {
      spawnDetached("wslview", [absPath], () => {
        const child = spawn("wslpath", ["-w", absPath], {
          stdio: ["ignore", "pipe", "ignore"],
        }) as unknown as EventedChild
        let out = ""
        child.stdout?.on("data", (b: Buffer) => {
          out += b.toString()
        })
        child.on("close", (code: number | null) => {
          if (code === 0) spawnDetached("explorer.exe", [out.trim()])
        })
      })
      return
    }
    spawnDetached("xdg-open", [absPath])
    return
  }
  if (plat === "darwin") {
    spawnDetached("open", [absPath])
    return
  }
  if (plat === "win32") {
    spawnDetached("cmd.exe", ["/c", "start", "", absPath])
    return
  }
}

function spawnDetached(cmd: string, args: readonly string[], onError?: () => void): void {
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true }) as unknown as EventedChild
    child.on("error", () => onError?.())
    child.unref()
  } catch {
    onError?.()
  }
}
