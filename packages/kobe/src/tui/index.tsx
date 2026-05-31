/**
 * kobe TUI bootstrap (v0.6).
 *
 * Thin entry point. Default path is direct tmux attach; the old
 * opentui outer monitor is a deprecated fallback for recovery/dev.
 */

import { maybeHintSkillInstall } from "../lib/skill-install.ts"

export async function startTui(): Promise<void> {
  // One-time nudge (before the tmux/opentui takeover): if the kobe agent
  // skill isn't installed, tell the user how. Best-effort — the reliable
  // check is `kobe doctor`. No-op when installed or already shown once.
  maybeHintSkillInstall()

  // Deprecated fallback: the old opentui outer monitor still exists for
  // settings/diagnostics/dev recovery, but the default product path is
  // now inner-first tmux against the single shared daemon.
  if (process.env.KOBE_OUTER_MONITOR !== "1" && process.env.KOBE_NO_DAEMON !== "1") {
    const { startDirectTmux } = await import("./direct")
    await startDirectTmux()
    return
  }
  const { startApp } = await import("./app")
  await startApp()
}
