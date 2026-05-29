/**
 * kobe TUI bootstrap (v0.6).
 *
 * Thin entry point — delegates immediately to `app.tsx`, which owns
 * the v0.6 layout (sidebar + ClaudeLauncher), orchestrator wiring,
 * and keybindings.
 */

import type { TuiDaemonMode } from "../daemon/mode.ts"
import { startApp } from "./app"

export async function startTui(options: { daemonMode?: TuiDaemonMode } = {}): Promise<void> {
  await startApp(options)
}
