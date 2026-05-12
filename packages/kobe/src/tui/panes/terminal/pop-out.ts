/**
 * Pop a kobe terminal pane out into a real external terminal — as a
 * Windows Terminal **split pane** in the current window, not a new tab
 * or new window.
 *
 * Why split-pane: the user wants the visual experience of "kobe + a
 * real terminal in the bottom right of the same window." A TUI can't
 * embed a real terminal in one of its own regions (host terminal owns
 * the cell grid), but the HOST TERMINAL can split itself — so kobe
 * asks Windows Terminal to carve off a pane next to itself and put a
 * `tmux attach -t <session>` inside. From the user's perspective the
 * outcome is identical: one Windows Terminal window, kobe on top /
 * left, real native-latency terminal on bottom / right.
 *
 * The split pane is a sibling of kobe's pane at the WT layer, NOT
 * inside kobe's TUI. WT handles cursor placement, GPU rendering, and
 * focus/resize for both panes natively.
 *
 * Today only WSL hosts are supported (we shell out to `wt.exe`). On
 * macOS / native Linux this no-ops; the caller falls back to the
 * embedded pane.
 */

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * Sessions we've already split a WT pane for. Each `<Terminal />`
 * mount triggers the auto-pop, but we don't want to keep spawning
 * panes for the same session as the user navigates around kobe.
 */
const popped = new Set<string>()

/**
 * Cheap, sync WSL probe. WSL kernels report "microsoft" or "WSL" in
 * `/proc/version`.
 */
function isWsl(): boolean {
  try {
    return /microsoft|wsl/i.test(readFileSync("/proc/version", "utf8"))
  } catch {
    return false
  }
}

export type PopOutResult = { ok: true } | { ok: false; reason: string }

/**
 * Ask Windows Terminal to split the active window and run
 * `wsl tmux attach -t <attachTarget>` in the new pane. Idempotent
 * per session.
 *
 * Args we pass to `wt.exe`:
 *   - `-w 0` targets the currently-focused WT window. If kobe is
 *     running inside WT (the common case), this splits THIS window
 *     instead of opening a new one.
 *   - `split-pane -H` creates a horizontal split — new pane appears
 *     **below** the current one. (Use `-V` for a side-by-side split
 *     if you want a right-hand pane instead. `-H` matches Conductor's
 *     bottom-row terminal placement, which is what kobe targets.)
 *   - `-s 0.4` sizes the new pane at 40 % of the parent's height.
 *     User can drag the WT pane divider to adjust.
 *   - The rest is the command the new pane runs: `wsl tmux attach -t
 *     <name>`. `wsl` invokes the default distro; tmux then attaches
 *     to the shell kobe already created for this task.
 *
 * Disable with `KOBE_TERMINAL_NO_POPOUT=1` (run on a host without WT,
 * or to keep kobe single-paned for testing).
 */
export function popOutToExternalTerminal(attachTarget: string): PopOutResult {
  if (process.env.KOBE_TERMINAL_NO_POPOUT === "1") {
    return { ok: false, reason: "disabled via KOBE_TERMINAL_NO_POPOUT=1" }
  }
  if (popped.has(attachTarget)) return { ok: true }
  if (!isWsl()) {
    return { ok: false, reason: "pop-out only supported on WSL right now" }
  }

  // wt.exe inherits Windows %PATH% and is reachable as a bare command
  // from inside WSL. No cmd.exe wrapper needed; wt.exe parses its own
  // args including the tail command.
  try {
    const proc = spawn(
      "wt.exe",
      [
        "-w",
        "0",
        "split-pane",
        "-H",
        "-s",
        "0.4",
        "wsl",
        "tmux",
        "attach",
        "-t",
        attachTarget,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    )
    proc.on("error", () => {
      // Either wt.exe is missing, or `-w 0` refused (kobe not in a WT
      // window). Drop the cache so a later run can retry.
      popped.delete(attachTarget)
    })
    proc.unref()
    popped.add(attachTarget)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: (err as Error).message }
  }
}

/**
 * Reset the "already split" cache. Tests use this between cases.
 */
export function _resetPopOutCache(): void {
  popped.clear()
}
