/** System-clipboard command resolution, kept outside render-path modules. */

import { spawnSync } from "node:child_process"

export type ClipboardProbe = (binary: string) => boolean

const LINUX_CLIPBOARD_CANDIDATES: readonly { readonly binary: string; readonly command: string }[] = [
  { binary: "wl-copy", command: "wl-copy" },
  { binary: "xclip", command: "xclip -selection clipboard -in" },
  { binary: "xsel", command: "xsel --clipboard --input" },
]

export function resolveClipboardCopyCommand(
  platform: NodeJS.Platform | string,
  hasCommand: ClipboardProbe,
): string | null {
  if (platform === "darwin") return "pbcopy"
  if (platform === "linux") {
    for (const candidate of LINUX_CLIPBOARD_CANDIDATES) {
      if (hasCommand(candidate.binary)) return candidate.command
    }
  }
  return null
}

export const clipboardBinaryOnPath: ClipboardProbe = (binary) => {
  try {
    const command = process.platform === "win32" ? "where" : "which"
    return spawnSync(command, [binary], { encoding: "utf8" }).status === 0
  } catch {
    return false
  }
}
