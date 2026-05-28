#!/usr/bin/env bun
/**
 * kobe CLI entry point (v0.6).
 *
 * Subcommands surface:
 *   - `kobe`                    Launch the TUI (default).
 *   - `kobe add [path]`         Save a repo path for the new-task picker.
 *   - `kobe daemon <verb>`      Manage the long-lived daemon (start / stop / status / restart).
 *   - `kobe theme <verb>`       Manage user themes.
 *   - `kobe update [target]`    Self-update (when packaged).
 *
 * v0.5 had `diagnose`, `mcp-bridge`, `api`, `skill`, and pane-host
 * test fixtures. All gone in v0.6 (no engine port to diagnose, no
 * MCP bridge, no behavior fixtures).
 */
import { resolve } from "node:path"
import { parseCliArgs } from "./daemon-mode.ts"

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

interface OpsFlags {
  taskId?: string
  worktree?: string
  targetPane?: string
  /** When set, render the full-width file preview for this rel path instead of the FileTree. */
  preview?: string
}

/** Parse `kobe ops` flags. */
function parseOpsFlags(argv: readonly string[]): OpsFlags {
  const flags: OpsFlags = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) continue
    if (flag === "--task-id") {
      flags.taskId = value
      i++
    } else if (flag === "--worktree") {
      flags.worktree = value
      i++
    } else if (flag === "--target-pane") {
      flags.targetPane = value
      i++
    } else if (flag === "--preview") {
      flags.preview = value
      i++
    }
  }
  return flags
}

async function main(): Promise<void> {
  const [, , ...rawArgs] = process.argv
  let parsed: ReturnType<typeof parseCliArgs>
  try {
    parsed = parseCliArgs(rawArgs)
  } catch (err) {
    console.error(`kobe: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(2)
  }
  const [subcommand, ...rest] = parsed.args
  if (subcommand === "add") {
    await runAddSubcommand(rest[0])
    return
  }
  if (subcommand === "update") {
    const { runUpdateSubcommand } = await import("./update.ts")
    await runUpdateSubcommand(rest)
    return
  }
  if (subcommand === "theme") {
    const { runThemeSubcommand } = await import("./theme.ts")
    await runThemeSubcommand(rest)
    return
  }
  if (subcommand === "daemon") {
    const { runDaemonSubcommand } = await import("./daemon-cmd.ts")
    await runDaemonSubcommand(rest)
    return
  }
  if (subcommand === "ops") {
    // The Ops pane (right side of the per-task tmux session). Runs in
    // its own process inside the tmux pane; mounts the v0.5 FileTree
    // against the task's worktree. Dynamic import keeps opentui out of
    // the other subcommands' startup graph.
    const flags = parseOpsFlags(rest)
    if (!flags.worktree) {
      console.error("kobe ops: --worktree <path> is required")
      process.exit(2)
    }
    // `--preview <rel>` → full-width syntax-highlighted file/diff view
    // (opentui `<diff>` / `<code>`). Otherwise the FileTree browser.
    if (flags.preview) {
      const { startOpsPreview } = await import("../tui/ops/host.tsx")
      await startOpsPreview({ worktree: flags.worktree, relPath: flags.preview })
      return
    }
    const { startOpsHost } = await import("../tui/ops/host.tsx")
    await startOpsHost({
      taskId: flags.taskId ?? "",
      worktree: flags.worktree,
      targetPane: flags.targetPane ?? null,
    })
    return
  }

  // Default: launch the TUI. Dynamic import so non-TUI subcommands
  // (like `kobe add`) don't pull in opentui/solid at startup.
  const { startTui } = await import("../tui/index.tsx")
  await startTui({ daemonMode: parsed.daemonMode })
}

main().catch((err) => {
  console.error("kobe failed to start:", err)
  process.exit(1)
})
