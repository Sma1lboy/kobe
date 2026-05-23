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

  // Default: launch the TUI. Dynamic import so non-TUI subcommands
  // (like `kobe add`) don't pull in opentui/solid at startup.
  const { startTui } = await import("../tui/index.tsx")
  await startTui({ daemonMode: parsed.daemonMode })
}

main().catch((err) => {
  console.error("kobe failed to start:", err)
  process.exit(1)
})
