/**
 * kobe TUI bootstrap.
 *
 * Thin entry point: plain `kobe` starts the Workspace Host. The opentui outer monitor (`app.tsx`) and its
 * `KOBE_OUTER_MONITOR` / `KOBE_NO_DAEMON` escape hatches were retired —
 * see docs/design/app-retirement.md. Daemon recovery is `kobe daemon
 * restart`, not a daemon-less in-process Orchestrator.
 */

import { enforceResetGate } from "../cli/reset-gate.ts"
import { maybeHintSkillInstall } from "../lib/skill-install.ts"
import { publishKobeTerminalTitle } from "./lib/outer-terminal-title.ts"

export async function startTui(): Promise<void> {
  // Breaking-version gate first: refuse to touch daemon/session state that
  // a version in BREAKING_VERSIONS made incompatible (run `kobe reset`).
  enforceResetGate()

  // Own the outer emulator's tab/window title while kobe is running. Without
  // an OSC title, iTerm2 falls back to the packaged JavaScript runtime name
  // (observed as "node") instead of the product the user launched.
  publishKobeTerminalTitle()

  // One-time nudge: if the kobe agent
  // skill isn't installed, tell the user how. Best-effort — the reliable
  // check is `kobe skill status`. No-op when installed or already shown once.
  maybeHintSkillInstall()

  const { startWorkspaceHost } = await import("../tui-react/workspace/host.tsx")
  await startWorkspaceHost()
}
