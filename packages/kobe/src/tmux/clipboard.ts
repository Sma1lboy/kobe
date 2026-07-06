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
    return null
  }
  return null
}

export const clipboardBinaryOnPath: ClipboardProbe = (binary) => {
  try {
    const cmd = process.platform === "win32" ? "where" : "which"
    return spawnSync(cmd, [binary], { encoding: "utf8" }).status === 0
  } catch {
    return false
  }
}

export type TmuxCommand = readonly string[]

const COPY_MODE_TABLES = ["copy-mode", "copy-mode-vi"] as const

const COPY_FINISH_TRIGGERS = ["MouseDragEnd1Pane", "y", "Enter"] as const

export function clipboardTmuxConfig(clipboardCopyCommand: string | null): TmuxCommand[] {
  const config: TmuxCommand[] = [["set-option", "-g", "set-clipboard", "on"]]
  if (clipboardCopyCommand) {
    config.push(["set-option", "-g", "copy-command", clipboardCopyCommand])
    for (const table of COPY_MODE_TABLES) {
      for (const trigger of COPY_FINISH_TRIGGERS) {
        config.push(["bind-key", "-T", table, trigger, "send-keys", "-X", "copy-pipe-and-cancel", clipboardCopyCommand])
      }
    }
  }
  return config
}
