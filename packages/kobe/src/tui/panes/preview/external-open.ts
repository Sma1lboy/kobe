/**
 * Spawn the OS-default application to open a path (KOB-14 "copy-path
 * hint" → "actually open it"). Used by the preview pane's `o`
 * binding when the active tab is a media file we can't render inline
 * (PDF, video, audio, archives, fonts).
 *
 * Platform selection:
 *   - WSL  → prefer `wslview` (poppler/util alias for `xdg-open`);
 *            fall back to `cmd.exe /c start "" <winpath>` after
 *            converting the WSL path via `wslpath -w`. The fallback
 *            path is what most users hit because wslview isn't part
 *            of base Ubuntu-on-WSL.
 *   - macOS → `open <path>`.
 *   - Windows native → `cmd /c start "" <path>`.
 *   - Other (Linux desktop) → `xdg-open <path>`.
 *
 * Fire-and-forget: we spawn detached and `unref()` so the kobe TUI
 * doesn't keep a handle to the long-lived viewer. The function
 * returns true on a successful spawn, false on a synchronous spawn
 * error — the viewer's own exit code is not reported back. The TUI
 * doesn't surface async failures either; a viewer that fails to
 * launch leaves the user where they were, which is the right UX for
 * a soft "open externally" gesture.
 */

import { type ChildProcess, execFileSync, spawn } from "node:child_process"

/** Detect WSL via the standard environment variable Microsoft sets. */
function isWsl(): boolean {
  return Boolean(process.env.WSL_DISTRO_NAME) || Boolean(process.env.WSL_INTEROP)
}

/** Convert a POSIX path under WSL to a `\\wsl.localhost\…` Windows path. */
function toWindowsPath(posixPath: string): string | null {
  try {
    return execFileSync("wslpath", ["-w", posixPath], { stdio: ["ignore", "pipe", "ignore"] })
      .toString("utf8")
      .trim()
  } catch {
    return null
  }
}

function spawnDetached(cmd: string, args: readonly string[]): boolean {
  let child: ChildProcess | null = null
  try {
    child = spawn(cmd, [...args], { stdio: "ignore", detached: true })
  } catch {
    return false
  }
  let okSoFar = true
  child.on("error", () => {
    // Synchronous spawn failures land here too; the parent process
    // ignores them — caller already returned.
    okSoFar = false
  })
  child.unref()
  return okSoFar
}

/**
 * Open `absPath` in the OS default application. Always returns
 * synchronously — true if the spawn appears to have launched, false
 * if the platform's primary opener is unavailable.
 */
export function openExternal(absPath: string): boolean {
  if (!absPath) return false
  if (isWsl()) {
    // Try wslview first (preferred — handles file URLs cleanly when
    // installed via wslu). Spawn-error fallback runs cmd.exe.
    if (spawnDetached("wslview", [absPath])) return true
    const winPath = toWindowsPath(absPath)
    if (!winPath) return false
    // `start` is a cmd builtin, not a binary — must go through cmd.exe.
    // The empty `""` is the title argument (else cmd interprets a quoted
    // path as the title).
    return spawnDetached("cmd.exe", ["/c", "start", "", winPath])
  }
  if (process.platform === "darwin") {
    return spawnDetached("open", [absPath])
  }
  if (process.platform === "win32") {
    return spawnDetached("cmd.exe", ["/c", "start", "", absPath])
  }
  return spawnDetached("xdg-open", [absPath])
}
