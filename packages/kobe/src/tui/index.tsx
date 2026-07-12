/**
 * kobe TUI bootstrap.
 *
 * Thin entry point: `kobe` goes straight into the tmux workspace
 * (`direct.ts`). The opentui outer monitor (`app.tsx`) and its
 * `KOBE_OUTER_MONITOR` / `KOBE_NO_DAEMON` escape hatches were retired —
 * see docs/design/app-retirement.md. Daemon recovery is `kobe doctor` /
 * `kobe reset`, not a daemon-less in-process Orchestrator.
 */

import type { LaunchMode } from "../launch-mode.ts"
import { maybeHintSkillInstall } from "../lib/skill-install.ts"
import { publishKobeTerminalTitle } from "./lib/outer-terminal-title.ts"

export async function startTui(mode: LaunchMode): Promise<void> {
  // Own the outer emulator's tab/window title while kobe is running. Without
  // an OSC title, iTerm2 falls back to the packaged JavaScript runtime name
  // (observed as "node") instead of the product the user launched.
  publishKobeTerminalTitle()

  // One-time nudge (before the tmux takeover): if the kobe agent
  // skill isn't installed, tell the user how. Best-effort — the reliable
  // check is `kobe doctor`. No-op when installed or already shown once.
  maybeHintSkillInstall()

  if (mode === "puretui") {
    // The native workspace is React-only (issue #16 — the Solid host was removed).
    const { startWorkspaceHost } = await import("../tui-react/workspace/host.tsx")
    await startWorkspaceHost()
    return
  }

  const { startDirectTmux } = await import("./direct")
  await startDirectTmux()
}
