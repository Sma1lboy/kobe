/**
 * kobe CLI entry point.
 *
 * Phase 0.1 scope: just boot the TUI. Argv parsing is a stub for now —
 * we'll wire up Commander/yargs once the engine + orchestrator are in.
 */
import { startTui } from "../tui/index.tsx"

async function main(): Promise<void> {
  // Future: parse argv here (e.g. `kobe --repo <path>`, `kobe new "title"`).
  // For 0.1 we just open the TUI.
  await startTui()
}

main().catch((err) => {
  console.error("kobe failed to start:", err)
  process.exit(1)
})
