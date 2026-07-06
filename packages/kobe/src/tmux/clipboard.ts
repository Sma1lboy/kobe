/**
 * System-clipboard copy-command resolution for the tmux workspace.
 *
 * A plain left-mouse drag in the workspace enters tmux copy-mode and
 * selects WITHIN the focused pane (pane-aware, the desired behaviour).
 * But tmux's default only lands that selection in its own internal paste
 * buffer — never the OS clipboard — so users fall back to the terminal's
 * native Option+drag, which bleeds the selection ACROSS panes.
 *
 * The session config (see `panes/terminal/tmux.ts`) closes that gap by
 * piping the copy-mode "finish selection" actions to the platform
 * clipboard command resolved here (plus `set-clipboard on` as an OSC 52
 * fallback). This module is the PURE resolver: platform → shell command
 * string, with the binary probe injected so it is unit-testable and never
 * throws on a missing tool.
 */

import { spawnSync } from "node:child_process"

/** Probe whether a binary is resolvable on PATH. Best-effort, never throws. */
export type ClipboardProbe = (binary: string) => boolean

/**
 * Linux clipboard candidates, in preference order: Wayland first, then the
 * two common X11 tools. Each entry is the binary to probe plus the full
 * command tmux pipes the selection into.
 */
const LINUX_CLIPBOARD_CANDIDATES: readonly { readonly binary: string; readonly command: string }[] = [
  { binary: "wl-copy", command: "wl-copy" },
  { binary: "xclip", command: "xclip -selection clipboard -in" },
  { binary: "xsel", command: "xsel --clipboard --input" },
]

/**
 * Resolve the shell command tmux should pipe a copy-mode selection into to
 * reach the system clipboard, or `null` when no tool is available (the
 * caller then relies on OSC 52 via `set-clipboard on`).
 *
 * - darwin → `pbcopy`
 * - linux  → first available of wl-copy / xclip / xsel
 * - anything else → `null`
 */
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

/**
 * Default PATH probe (`which`/`where`). Best-effort: any spawn failure is
 * treated as "not found" so resolution can never break session creation.
 */
export const clipboardBinaryOnPath: ClipboardProbe = (binary) => {
  try {
    const cmd = process.platform === "win32" ? "where" : "which"
    return spawnSync(cmd, [binary], { encoding: "utf8" }).status === 0
  } catch {
    return false
  }
}

/** A single tmux command as the argv tuple `runTmuxSequence` consumes. */
export type TmuxCommand = readonly string[]

/**
 * Copy-mode tables tmux selects between based on `mode-keys`. We bind in both
 * so the copy reaches the clipboard regardless of the user's tmux.conf.
 */
const COPY_MODE_TABLES = ["copy-mode", "copy-mode-vi"] as const

/**
 * Copy-mode "finish selection" triggers: the mouse drag-release (the exact
 * user flow) plus the keyboard copy keys, so keyboard copy reaches the
 * clipboard too.
 */
const COPY_FINISH_TRIGGERS = ["MouseDragEnd1Pane", "y", "Enter"] as const

/**
 * Build the clipboard portion of the tmux session config. Always emits
 * `set-clipboard on` (the OSC 52 path, terminal-permitting); when a local
 * clipboard command is available it ALSO binds the copy-mode finish actions to
 * `copy-pipe-and-cancel <cmd>` in both copy-mode tables. With no command the
 * copy-pipe bindings are omitted but `set-clipboard on` stays.
 *
 * `copy-command` is set alongside the bindings because a user tmux.conf can
 * rewrite them: oh-my-tmux (gpakosz) dumps `list-keys` and, with its default
 * `tmux_conf_copy_to_os_clipboard=false`, strips the `<cmd>` argument off
 * every `copy-pipe*` binding — including ours — leaving a bare
 * `copy-pipe-and-cancel`. On tmux ≥ 3.2 a bare copy-pipe falls back to the
 * `copy-command` option, so setting it keeps the copy reaching the OS
 * clipboard even after that rewrite.
 */
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
