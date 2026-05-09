/**
 * kobe CLI entry point.
 *
 * Phase 0.1 scope: just boot the TUI. Argv parsing is a stub for now —
 * we'll wire up Commander/yargs once the engine + orchestrator are in.
 *
 * Test-mode branches:
 *   - `KOBE_TERMINAL_HOST=1` — mount only the terminal pane (Stream J's
 *     behavior test fixture). Uses `KOBE_TERMINAL_CWD` for the shell
 *     cwd. The host fixture lives under `test/behavior/fixtures/` so
 *     the production bundle doesn't ship it; the import is a runtime
 *     dynamic require gated on the env var.
 */
import { startTui } from "../tui/index.tsx"

async function main(): Promise<void> {
  if (process.env.KOBE_TERMINAL_HOST === "1") {
    // Late import — keeps the test fixture out of the production
    // bundle's static graph.
    const { startTerminalHost } = await import("../../test/behavior/fixtures/terminal-host.tsx")
    await startTerminalHost()
    return
  }
  // Future: parse argv here (e.g. `kobe --repo <path>`, `kobe new "title"`).
  // For 0.1 we just open the TUI.
  await startTui()
}

main().catch((err) => {
  console.error("kobe failed to start:", err)
  process.exit(1)
})
