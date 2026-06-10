/**
 * kobe TUI bootstrap.
 *
 * Thin entry point: `kobe` goes straight into the tmux workspace
 * (`direct.ts`). The opentui outer monitor (`app.tsx`) and its
 * `KOBE_OUTER_MONITOR` / `KOBE_NO_DAEMON` escape hatches were retired —
 * see docs/design/app-retirement.md. Daemon recovery is `kobe doctor` /
 * `kobe reset`, not a daemon-less in-process Orchestrator.
 */

import { maybeHintSkillInstall } from "../lib/skill-install.ts"

export async function startTui(): Promise<void> {
  // One-time nudge (before the tmux takeover): if the kobe agent
  // skill isn't installed, tell the user how. Best-effort — the reliable
  // check is `kobe doctor`. No-op when installed or already shown once.
  maybeHintSkillInstall()

  const { startDirectTmux } = await import("./direct")
  await startDirectTmux()
}
