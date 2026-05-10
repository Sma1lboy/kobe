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
import { resolve } from "node:path"

/**
 * `kobe add [path]` — append a repo path to the saved-repos list shown
 * in the TUI's new-task picker (ctrl+n). Defaults to `.` (cwd). The
 * path is resolved to an absolute path before writing so the entry is
 * portable across shells. Idempotent: re-adding an already-saved repo
 * prints a notice but is not an error. Late dynamic import keeps the
 * TUI's solid-js graph out of this branch's startup path.
 */
async function runAddSubcommand(arg: string | undefined): Promise<void> {
  const target = resolve(process.cwd(), arg && arg.length > 0 ? arg : ".")
  const { addSavedRepo } = await import("../state/repos.ts")
  const result = addSavedRepo(target)
  if (result.added) {
    console.log(`added ${result.path} (${result.total} saved repo${result.total === 1 ? "" : "s"} total)`)
  } else {
    console.log(`already saved: ${result.path}`)
  }
}

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

  // Subcommand routing. process.argv = [bun, script, ...args].
  // Each branch dynamically imports its module so adding a new
  // subcommand never grows the TUI startup graph.
  const [, , subcommand, ...rest] = process.argv
  if (subcommand === "add") {
    await runAddSubcommand(rest[0])
    return
  }
  if (subcommand === "diagnose") {
    const { runDiagnoseSubcommand } = await import("./diagnose.ts")
    await runDiagnoseSubcommand()
    return
  }

  // Default: launch the TUI. Dynamic import so non-TUI subcommands
  // (like `kobe add` / `kobe diagnose`) don't pull in opentui/solid
  // at startup.
  const { startTui } = await import("../tui/index.tsx")
  await startTui()
}

main().catch((err) => {
  console.error("kobe failed to start:", err)
  process.exit(1)
})
