#!/usr/bin/env bun
/**
 * kobe CLI entry point (v0.6).
 *
 * Subcommands surface:
 *   - `kobe`                    Launch the TUI (default).
 *   - `kobe add [path]`         Save a repo path for the new-task picker.
 *   - `kobe adopt [glob]`       Import existing git worktrees as tasks.
 *   - `kobe api <verb>`         Scriptable RPC surface for agents (fan-out).
 *   - `kobe daemon <verb>`      Manage the long-lived daemon (start / stop / status / restart).
 *   - `kobe theme <verb>`       Manage user themes.
 *   - `kobe update [target]`    Self-update (when packaged).
 *   - `kobe doctor`             Diagnose daemon / tmux / state (read-only).
 *   - `kobe reset [--hard]`     Recover a wedged install: stop daemon +
 *                               kill sessions (+ wipe state with --hard).
 *   - `kobe kill-sessions`      Tear down kobe's tmux server (dev reset).
 *   - `kobe --version` / `-v`   Print version.
 *   - `kobe --help` / `-h`      Print usage.
 *
 * An unrecognized subcommand prints usage and exits non-zero (it does
 * NOT fall through to launching the TUI).
 *
 * Internal subcommands fired by tmux key bindings inside a task session
 * (not meant for direct use): `new-chattab`, `quick-create`, `tasks`,
 * `ops` — each takes the session/worktree as flags.
 *
 * `kobe api` returned in v0.6, re-architected for tmux: `send` delivers
 * a prompt via `tmux send-keys` into the task's engine pane, not the
 * deleted chat RPCs (see `./api-cmd.ts`). v0.5's `diagnose`, `mcp-bridge`,
 * `skill`, and pane-host test fixtures remain gone.
 */
import { resolve } from "node:path"
import { matchPathGlob } from "../lib/path-glob.ts"
import { ALL_VENDORS, type VendorId, coerceVendorId } from "../types/vendor.ts"
import type { AdoptableWorktree } from "../types/worktree.ts"
import { parseCliArgs } from "./daemon-mode.ts"
import { topLevelUsage } from "./usage.ts"

async function runAddSubcommand(arg: string | undefined): Promise<void> {
  if (arg === "--help" || arg === "-h" || arg === "help") {
    process.stdout.write(
      "Usage: kobe add [path]\n\nSave a repo path (default: the current directory) for the new-task picker.\n",
    )
    return
  }
  if (arg?.startsWith("-")) {
    process.stderr.write(`kobe add: unknown flag "${arg}"\n\nUsage: kobe add [path]\n`)
    process.exit(2)
  }
  const target = resolve(process.cwd(), arg && arg.length > 0 ? arg : ".")
  const { addSavedRepo } = await import("../state/repos.ts")
  const result = addSavedRepo(target)
  if (result.added) {
    console.log(`added ${result.path} (${result.total} saved repo${result.total === 1 ? "" : "s"} total)`)
  } else {
    console.log(`already saved: ${result.path}`)
  }
  // Fold in the repo's existing git worktrees: scan + adopt the ones not
  // yet linked to a task, most-recently-active first (KOB-256). A plain
  // repo with no extra worktrees imports nothing.
  await adoptAllWorktrees(result.path)
}

/**
 * Discover every unlinked git worktree of `repo` and adopt each as a
 * task (discovery sorts most-recently-active first). Used by `kobe add`
 * to fold a repo's worktrees in on the way (KOB-256).
 *
 * Discovery runs IN-PROCESS — `git worktree list` + a `tasks.json` read,
 * no daemon — so a plain repo with no extra worktrees stays instant and
 * never boots a daemon as a side effect of `kobe add`. Only when there's
 * something to import do we touch the daemon: a running one gets the
 * writes over RPC (so a live TUI updates and the on-disk index isn't
 * split-brained); with no daemon running we write in-process and a later
 * `kobe` launch reads the result. Best-effort throughout — a scan/adopt
 * failure is reported, not fatal to `kobe add`.
 */
async function adoptAllWorktrees(repo: string): Promise<void> {
  const orch = await openLocalOrchestrator()
  let candidates: readonly AdoptableWorktree[]
  try {
    candidates = await orch.discoverAdoptableWorktrees(repo)
  } catch (err) {
    console.error(`(skipped worktree scan: ${err instanceof Error ? err.message : String(err)})`)
    return
  }
  if (candidates.length === 0) return
  console.log(`scanning ${repo}: ${candidates.length} unlinked worktree(s) → importing`)
  await adoptWorktreesInto(orch, repo, candidates, coerceVendorId(undefined))
}

/** Build a short-lived in-process orchestrator (store + git manager) for
 * a one-shot CLI command. No daemon, no socket — just reads `tasks.json`
 * and shells git. */
async function openLocalOrchestrator() {
  const { TaskIndexStore } = await import("../orchestrator/index/store.ts")
  const { GitWorktreeManager } = await import("../orchestrator/worktree/manager.ts")
  const { Orchestrator } = await import("../orchestrator/core.ts")
  const store = new TaskIndexStore()
  await store.load()
  return new Orchestrator({ store, worktrees: new GitWorktreeManager() })
}

/**
 * Adopt `list` as tasks, printing one line each. Prefers a RUNNING
 * daemon (writes over RPC so a live TUI updates + the on-disk index
 * isn't split-brained); falls back to the in-process orchestrator when
 * no daemon is up. Never boots a daemon (KOB-256).
 */
async function adoptWorktreesInto(
  orch: Awaited<ReturnType<typeof openLocalOrchestrator>>,
  repo: string,
  list: readonly AdoptableWorktree[],
  vendor: VendorId,
): Promise<void> {
  const { connectIfRunning } = await import("../client/daemon-process.ts")
  const client = await connectIfRunning()
  try {
    for (const w of list) {
      const adopted = client
        ? (
            await client.request<{ task: { id: string; title: string } }>("worktree.adopt", {
              repo,
              worktreePath: w.path,
              branch: w.branch,
              vendor,
            })
          ).task
        : await orch.adoptWorktree({ repo, worktreePath: w.path, branch: w.branch, vendor })
      console.log(`  adopted ${w.branch} → task ${adopted.id} (${adopted.title})`)
    }
  } finally {
    client?.close()
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
const ADOPT_USAGE = [
  "Usage: kobe adopt [glob] [--repo <path>] [--vendor <v>] [--yes]",
  "",
  "Import existing git worktrees in a repo as kobe tasks.",
  "No glob → dry-run listing. With a glob → list matches; --yes adopts them.",
  "",
  "Options:",
  "  --repo <path>   Repo to scan (default: current directory)",
  "  --vendor <v>    Engine vendor for adopted tasks",
  "  -y, --yes       Actually adopt the matched worktrees",
  "  -h, --help      Print this help",
  "",
].join("\n")

function adoptUsageError(message: string): never {
  process.stderr.write(`kobe adopt: ${message}\n\n${ADOPT_USAGE}\n`)
  process.exit(2)
}

async function runAdoptSubcommand(args: readonly string[]): Promise<void> {
  let glob: string | undefined
  let repoArg: string | undefined
  let vendorArg: string | undefined
  let yes = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--help" || a === "-h" || a === "help") {
      process.stdout.write(`${ADOPT_USAGE}\n`)
      return
    }
    if (a === "--repo") {
      repoArg = args[++i]
      if (repoArg === undefined) adoptUsageError("--repo requires a value")
    } else if (a === "--vendor") {
      vendorArg = args[++i]
      if (vendorArg === undefined) adoptUsageError("--vendor requires a value")
    } else if (a === "--yes" || a === "-y") {
      yes = true
    } else if (a && !a.startsWith("-") && glob === undefined) {
      glob = a
    } else {
      // Unknown flag or a second positional → don't silently ignore it.
      adoptUsageError(`unexpected argument "${a}"`)
    }
  }

  const { resolveRepoRoot } = await import("../state/repos.ts")
  const repo = resolveRepoRoot(resolve(process.cwd(), repoArg && repoArg.length > 0 ? repoArg : "."))
  const vendor = coerceVendorId(vendorArg)

  // Discovery is a local read (git + tasks.json) — no daemon needed, so
  // listing never boots one (KOB-256).
  const orch = await openLocalOrchestrator()
  const worktrees = await orch.discoverAdoptableWorktrees(repo)
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
  await adoptWorktreesInto(orch, repo, matched, vendor)
  console.log(`done — adopted ${matched.length} worktree(s)`)
}

function printTopLevelUsage(out: Pick<typeof process.stderr, "write">): void {
  out.write(`${topLevelUsage()}\n`)
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

  if (subcommand === "--version" || subcommand === "-v" || subcommand === "version") {
    const { CURRENT_VERSION } = await import("../version.ts")
    console.log(`kobe ${CURRENT_VERSION}`)
    return
  }
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    printTopLevelUsage(process.stdout)
    return
  }

  if (subcommand === "add") {
    await runAddSubcommand(rest[0])
    return
  }
  if (subcommand === "adopt") {
    await runAdoptSubcommand(rest)
    return
  }
  if (subcommand === "api") {
    const { runApiSubcommand } = await import("./api-cmd.ts")
    await runApiSubcommand(rest)
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
    await runDoctorSubcommand(rest)
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
  if (subcommand === "settings") {
    // The Settings page as a standalone full-window surface (the default
    // `chattab` settings surface). Opened by `openSettingsTab` as a new
    // tmux window; reuses the same SettingsDialog the in-pane overlay
    // uses. Dynamic import keeps opentui off the other subcommands' path.
    const { startSettingsHost } = await import("../tui/settings/host.tsx")
    await startSettingsHost()
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

  // An unrecognized subcommand is a CLI error, not a TUI launch — a typo
  // like `kobe statsu` should print usage and exit non-zero, not silently
  // open the project. Only a bare `kobe` (no subcommand) launches the TUI.
  if (subcommand !== undefined) {
    console.error(`kobe: unknown command '${subcommand}'`)
    printTopLevelUsage(process.stderr)
    process.exit(2)
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
