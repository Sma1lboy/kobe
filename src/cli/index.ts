/**
 * kobe CLI entry point.
 *
 * Phase 0.1 scope: just boot the TUI. Argv parsing is a stub for now —
 * we'll wire up Commander/yargs once the engine + orchestrator are in.
 *
 * Wave 3 host-mode hooks: each Wave 3 pane stream (H file tree, G chat,
 * I diff, J terminal) ships a behavior test that mounts ONLY its pane
 * against a fixture, before the orchestrator wires the panes into the
 * 5-pane layout in `app.tsx`. We dispatch via a single env var per
 * stream — this is a deliberate cross-stream cooperation point that
 * the integration agent will reconcile at merge. Adding one if-branch
 * per stream is acceptable per Stream H's brief.
 */
import { startTui } from "../tui/index.tsx"

async function main(): Promise<void> {
  // Wave 3 Stream H — mount ONLY the file tree pane against a fixture
  // worktree when the host flag is set. The behavior test sets these
  // env vars before spawning kobe in a PTY.
  if (process.env.KOBE_FILETREE_HOST === "1") {
    const { startFileTreeHost } = await import("../../test/behavior/fixtures/filetree-host.tsx")
    await startFileTreeHost()
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
