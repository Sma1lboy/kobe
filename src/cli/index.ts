#!/usr/bin/env bun
/**
 * kobe CLI entry point.
 *
 * Phase 0.1 scope: just boot the TUI. Argv parsing is a stub for now —
 * we'll wire up Commander/yargs once the engine + orchestrator are in.
 *
 * Host-mode hooks (Wave 3 behavior testing):
 *   When a `KOBE_<PANE>_HOST=1` env var is set, we boot a stripped-down
 *   variant of kobe that mounts a single pane in isolation. This lets
 *   each pane stream's behavior test (Streams G/H/I/J) drive its own
 *   pane via PTY without spinning up the full app. Each branch is one
 *   if-statement — orchestrator merges keep them independent.
 *
 *   Late dynamic imports keep the test fixtures out of the production
 *   bundle's static graph.
 *
 *   - `KOBE_FILETREE_HOST=1` (Stream H) — mount `<FileTree>`. Uses
 *     `KOBE_FILETREE_WORKTREE`, `KOBE_FILETREE_OUTPUT`.
 *   - `KOBE_PREVIEW_HOST=1` (Stream I) — mount `<Preview>`. Uses
 *     `KOBE_PREVIEW_WORKTREE`, `KOBE_PREVIEW_DIFF_BASE`,
 *     `KOBE_PREVIEW_OPEN_FILE`.
 *   - `KOBE_TERMINAL_HOST=1` (Stream J) — mount `<Terminal>`. Uses
 *     `KOBE_TERMINAL_CWD`, `KOBE_TERMINAL_TASK_ID`.
 *
 *   Wave 4 polish may collapse these into a single `--host=<pane>` flag.
 *   For now keep one branch per pane so a broken pane doesn't take the
 *   others down.
 */
import { startTui } from "../tui/index.tsx"

async function main(): Promise<void> {
  if (process.env.KOBE_FILETREE_HOST === "1") {
    const { startFileTreeHost } = await import("../../test/behavior/fixtures/filetree-host.tsx")
    await startFileTreeHost()
    return
  }
  if (process.env.KOBE_PREVIEW_HOST === "1") {
    const { startPreviewHost } = await import("../../test/behavior/fixtures/preview-host.tsx")
    await startPreviewHost()
    return
  }
  if (process.env.KOBE_TERMINAL_HOST === "1") {
    const { startTerminalHost } = await import("../../test/behavior/fixtures/terminal-host.tsx")
    await startTerminalHost()
    return
  }
  // Subcommand dispatch. Argv shape for now: `kobe <subcommand> [args]`.
  // We only inspect argv[2]; anything else is forwarded to the TUI start
  // path (which today ignores extra args). Each branch is one
  // if-statement and dynamically imports its module so adding a new
  // subcommand never grows the TUI startup graph.
  const subcommand = process.argv[2]
  if (subcommand === "diagnose") {
    const { runDiagnoseSubcommand } = await import("./diagnose.ts")
    await runDiagnoseSubcommand()
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
