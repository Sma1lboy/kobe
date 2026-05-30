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
 *   - `kobe doctor`             Diagnose daemon / tmux / state (read-only).
 *   - `kobe reset [--hard]`     Recover a wedged install: stop daemon +
 *                               kill sessions (+ wipe state with --hard).
 *   - `kobe kill-sessions`      Tear down kobe's tmux server (dev reset).
 *
 * Internal subcommands fired by tmux key bindings inside a task session
 * (not meant for direct use): `new-chattab`, `quick-create`, `tasks`,
 * `ops` — each takes the session/worktree as flags.
 *
 * v0.5 had `diagnose`, `mcp-bridge`, `api`, `skill`, and pane-host
 * test fixtures. All gone in v0.6 (no engine port to diagnose, no
 * MCP bridge, no behavior fixtures).
 */
import { resolve } from "node:path"
import { matchPathGlob } from "../lib/path-glob.ts"
import { ALL_VENDORS, type VendorId, coerceVendorId } from "../types/vendor.ts"
import type { AdoptableWorktree } from "../types/worktree.ts"
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

/**
 * `kobe adopt [glob] [--repo <path>] [--vendor <v>] [--yes]` — scan a
 * repo's existing git worktrees (including ones outside
 * `.claude/worktrees/`) and import the ones not yet linked to a task
 * (KOB-256). No glob → dry-run listing. With a path glob → list matches;
 * `--yes` actually adopts them. Goes through the daemon so a running TUI
 * sees the new tasks live.
 */
async function runAdoptSubcommand(args: readonly string[]): Promise<void> {
  let glob: string | undefined
  let repoArg: string | undefined
  let vendorArg: string | undefined
  let yes = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--repo") {
      repoArg = args[++i]
    } else if (a === "--vendor") {
      vendorArg = args[++i]
    } else if (a === "--yes" || a === "-y") {
      yes = true
    } else if (a && !a.startsWith("-") && glob === undefined) {
      glob = a
    }
  }

  const { resolveRepoRoot } = await import("../state/repos.ts")
  const repo = resolveRepoRoot(resolve(process.cwd(), repoArg && repoArg.length > 0 ? repoArg : "."))
  const vendor = coerceVendorId(vendorArg)
  const { connectOrStartDaemon } = await import("../client/daemon-process.ts")
  const client = await connectOrStartDaemon()
  try {
    const { worktrees } = await client.request<{ worktrees: AdoptableWorktree[] }>("worktree.discoverAdoptable", {
      repo,
    })
    if (worktrees.length === 0) {
      console.log(`no adoptable worktrees for ${repo} — every git worktree here is already a task`)
      return
    }

    // Match by absolute path, and by basename for convenience (so
    // `kobe adopt 'feature-*'` works without typing the full path).
    const isMatch = (w: AdoptableWorktree) => !glob || matchPathGlob(glob, w.path)

    console.log(`adoptable worktrees in ${repo}:`)
    for (const w of worktrees) {
      const hit = glob ? (isMatch(w) ? "*" : " ") : "-"
      const tags = [w.dirty ? "dirty" : "", w.kobeManaged ? "" : "external"].filter(Boolean).join(",")
      console.log(`  ${hit} ${w.branch}\t${w.path}${tags ? `  (${tags})` : ""}`)
    }

    if (!glob) {
      console.log(`\npass a path glob to adopt, e.g.  kobe adopt '${repo}/*' --yes`)
      return
    }
    const matched = worktrees.filter(isMatch)
    if (matched.length === 0) {
      console.log(`\nno worktrees match glob ${JSON.stringify(glob)}`)
      return
    }
    if (!yes) {
      console.log(`\n${matched.length} worktree(s) match — re-run with --yes to adopt them`)
      return
    }
    for (const w of matched) {
      const { task } = await client.request<{ task: { id: string; title: string } }>("worktree.adopt", {
        repo,
        worktreePath: w.path,
        branch: w.branch,
        vendor,
      })
      console.log(`adopted ${w.branch} → task ${task.id} (${task.title})`)
    }
    console.log(`done — adopted ${matched.length} worktree(s)`)
  } finally {
    client.close()
  }
}

interface OpsFlags {
  taskId?: string
  worktree?: string
  targetPane?: string
  /** Task engine vendor — selects which transcript store the activity badge polls. */
  vendor?: string
  /** When set, render the full-width file preview for this rel path instead of the FileTree. */
  preview?: string
  /** tmux session name (used by `new-chattab`). */
  session?: string
}

/** Parse `kobe ops` / `kobe new-chattab` flags. */
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
    } else if (flag === "--vendor") {
      flags.vendor = value
      i++
    } else if (flag === "--preview") {
      flags.preview = value
      i++
    } else if (flag === "--session") {
      flags.session = value
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
  if (subcommand === "adopt") {
    await runAdoptSubcommand(rest)
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
  if (subcommand === "doctor") {
    const { runDoctorSubcommand } = await import("./maintenance.ts")
    await runDoctorSubcommand()
    return
  }
  if (subcommand === "reset") {
    const { runResetSubcommand } = await import("./maintenance.ts")
    await runResetSubcommand(rest)
    return
  }
  if (subcommand === "new-chattab") {
    // Ctrl+T handler from inside a task's tmux session — opens a new
    // chat-tab window. Reads the session name from `--session`; an
    // optional `--vendor` comes from the engine-choice tmux prompt.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe new-chattab: --session <name> is required")
      process.exit(2)
    }
    let vendor: VendorId | undefined
    if (flags.vendor !== undefined) {
      if (!ALL_VENDORS.includes(flags.vendor as VendorId)) {
        console.error(`kobe new-chattab: --vendor must be one of ${ALL_VENDORS.join(", ")}`)
        process.exit(2)
      }
      vendor = flags.vendor as VendorId
    }
    const { newChatTab } = await import("../tui/panes/terminal/tmux.ts")
    await newChatTab(session, vendor)
    return
  }
  if (subcommand === "kill-sessions") {
    // Dev/reset helper: tear down kobe's entire tmux server (all task
    // sessions on the `-L kobe` socket). Use after changing Tasks-pane /
    // Ops-pane / engine code so a long-lived session isn't still running
    // an OLD version of those panes. Does NOT touch the user's own tmux
    // (different socket) or the daemon (run `kobe daemon restart` for
    // that). No-op when no kobe server is running.
    const { runTmux, KOBE_TMUX_SOCKET } = await import("../tmux/client.ts")
    const code = await runTmux(["kill-server"])
    console.log(
      code === 0
        ? `kobe: killed all tmux sessions on the \`${KOBE_TMUX_SOCKET}\` socket`
        : `kobe: no tmux sessions to kill on the \`${KOBE_TMUX_SOCKET}\` socket`,
    )
    return
  }
  if (subcommand === "quick-create") {
    // Ctrl+F handler from inside a task's tmux session — focuses the
    // Tasks pane and opens its new-task dialog. Reads `--session`.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe quick-create: --session <name> is required")
      process.exit(2)
    }
    const { quickCreate } = await import("../tui/panes/terminal/tmux.ts")
    await quickCreate(session)
    return
  }
  if (subcommand === "tasks") {
    // Experimental Tasks pane (left side of a task's tmux session) —
    // a read-only task list that `switch-client`s between sessions.
    const { startTasksPane } = await import("../tui/tasks-pane/host.tsx")
    await startTasksPane()
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
      vendor: coerceVendorId(flags.vendor),
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
