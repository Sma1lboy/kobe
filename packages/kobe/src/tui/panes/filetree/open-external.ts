/**
 * Spawn the host OS's default application to open a file path. Used
 * by the file-tree pane's `o` keybinding so audio / video / PDF files
 * (which kobe can't play inside a TUI) reach a real player.
 *
 * Platform routing:
 *   - WSL (Linux running under Windows) → `wslview` if available,
 *     otherwise `explorer.exe` with a `wslpath -w` converted path.
 *   - Plain Linux → `xdg-open`.
 *   - macOS → `open`.
 *   - Windows native → `start` (cmd.exe builtin).
 *
 * We don't wait on the child process — these openers fire-and-forget,
 * detaching themselves and unrefing so kobe can exit without orphans.
 */

import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { platform } from "node:os"

export function openExternally(absPath: string): void {
  if (!absPath) return
  const plat = platform()
  if (plat === "linux") {
    // WSL detection: /proc/sys/fs/binfmt_misc/WSLInterop or env var.
    if (existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") || process.env.WSL_DISTRO_NAME) {
      // Prefer wslview when installed (wslu package); falls back to
      // explorer.exe with the Windows-mapped path otherwise.
      spawnDetached("wslview", [absPath], () => {
        const child = spawn("wslpath", ["-w", absPath], { stdio: ["ignore", "pipe", "ignore"] })
        let out = ""
        child.stdout.on("data", (b: Buffer) => {
          out += b.toString()
        })
        child.on("close", (code) => {
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
    const child = spawn(cmd, args, { stdio: "ignore", detached: true })
    child.on("error", () => onError?.())
    child.unref()
  } catch {
    onError?.()
  }
}
