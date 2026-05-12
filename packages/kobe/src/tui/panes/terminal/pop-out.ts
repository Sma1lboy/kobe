/**
 * Pop a kobe terminal pane out into a real external terminal window.
 *
 * The embedded terminal pane (whether tmux- or `@xterm/headless`-backed)
 * routes every keystroke through Solid + opentui's render loop, which
 * adds ~10-20 ms of paint cost per character. Once you've felt a real
 * terminal, that's perceptible. The trick: kobe's tmux backend already
 * keeps the live shell in a tmux session — any external terminal can
 * attach to that same session with `tmux attach -t <name>` and get
 * truly native typing latency. Same shell, same cwd, same env, same
 * scrollback. kobe's pane keeps mirroring it via `capture-pane`.
 *
 * Today this targets WSL hosts and shells out to Windows Terminal
 * (`wt.exe`). On macOS / native Linux we'd want a different terminal
 * spawn, so the function is best-effort: returns false on unsupported
 * platforms instead of throwing, so the caller can show a hint.
 */

import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"

/**
 * Sessions we've already opened a window for, so re-renders of
 * `<Terminal />` don't keep spawning windows. Stored by the
 * `tmux attach -t` target string.
 */
const popped = new Set<string>()

/**
 * Cheap, sync WSL probe. WSL kernels report "microsoft" or "WSL" in
 * `/proc/version`. The string is fixed per-host so reading once and
 * caching would also work, but the cost is low enough.
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
 * Spawn a Windows Terminal window that runs `tmux attach -t <name>`
 * inside the default WSL distro. Detaches the child so it survives a
 * kobe restart and doesn't keep stdin/stdout open against the kobe
 * process. Idempotent per `attachTarget`.
 *
 * Honors `KOBE_TERMINAL_NO_POPOUT=1` as a per-host opt-out for users
 * who want kobe's embedded pane to stay primary (e.g. running kobe in
 * a non-WSL container).
 */
export function popOutToExternalTerminal(attachTarget: string): PopOutResult {
  // Default is opt-IN now: the in-window modal terminal (click the pane,
  // double-Esc to exit) is the primary "native typing" path. External
  // pop-out is for users who want a persistent separate window — set
  // `KOBE_TERMINAL_POPOUT=1` to re-enable.
  if (process.env.KOBE_TERMINAL_POPOUT !== "1") {
    return { ok: false, reason: "external pop-out is opt-in; set KOBE_TERMINAL_POPOUT=1" }
  }
  if (popped.has(attachTarget)) return { ok: true }
  if (!isWsl()) {
    return { ok: false, reason: "pop-out only supported on WSL right now" }
  }

  // wt.exe is on Windows %PATH%; WSL inherits Windows PATH, so a bare
  // `wt.exe` resolves correctly. We don't shell out through cmd.exe to
  // dodge its quoting rules — wt.exe accepts a free-form command line
  // and runs it through the chosen distro.
  try {
    const proc = spawn("wt.exe", ["wsl", "tmux", "attach", "-t", attachTarget], {
      detached: true,
      stdio: "ignore",
    })
    proc.on("error", () => {
      // wt.exe not installed (rare on modern Windows) — don't crash; the
      // caller already treats a non-ok result as "show a hint".
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
 * Reset the "already popped" cache. Tests use this between cases so
 * one test's pop-out doesn't suppress another's.
 */
export function _resetPopOutCache(): void {
  popped.clear()
}
