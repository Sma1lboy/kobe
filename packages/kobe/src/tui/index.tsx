/**
 * kobe TUI bootstrap (v0.6).
 *
 * Thin entry point. Default path is direct tmux attach; the old
 * opentui outer monitor is a deprecated fallback for recovery/dev.
 */

import type { TuiDaemonMode } from "../daemon/mode.ts"

export async function startTui(options: { daemonMode?: TuiDaemonMode } = {}): Promise<void> {
  // Deprecated fallback: the old opentui outer monitor still exists for
  // settings/diagnostics/dev recovery, but the default product path is
  // now inner-first tmux. `--single` also stays on the old shell because
  // direct mode needs the stable daemon socket to survive Ctrl+Q detach.
  if (process.env.KOBE_OUTER_MONITOR !== "1" && process.env.KOBE_NO_DAEMON !== "1" && options.daemonMode !== "single") {
    const { startDirectTmux } = await import("./direct")
    await startDirectTmux()
    return
  }
  const { startApp } = await import("./app")
  await startApp(options)
}
