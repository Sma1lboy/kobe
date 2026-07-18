/**
 * Open a LOCAL file in the OS's default viewer (Preview.app, an image
 * viewer, …). Used by the ops preview for files the TUI can't render
 * (images / binaries) — the terminal has no portable inline-image path
 * (sixel/kitty/iTerm2 are fragmented and @opentui/core doesn't render
 * them), so "preview an image" means handing it to the system.
 */

import { spawn } from "node:child_process"

/** Pure: the platform's open-with-default-app argv. */
export function systemOpenArgv(absPath: string, platform: NodeJS.Platform = process.platform): readonly string[] {
  if (platform === "darwin") return ["open", absPath]
  // `start` is a cmd builtin; the empty "" is its window-title slot so a
  // path with spaces isn't eaten as the title.
  if (platform === "win32") return ["cmd", "/c", "start", "", absPath]
  return ["xdg-open", absPath]
}

/** Fire-and-forget system open. Soft-fails — a missing opener never crashes the TUI. */
export function openWithSystemViewer(absPath: string): void {
  try {
    const [cmd, ...args] = systemOpenArgv(absPath)
    spawn(cmd ?? "", args, { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref()
  } catch {
    // ponytail: no user-facing error surface; the key just no-ops if the
    // platform opener is missing.
  }
}
