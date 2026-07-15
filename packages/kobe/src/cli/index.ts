#!/usr/bin/env bun
import { resolve } from "node:path"
/**
 * kobe CLI entry point (v0.6).
 *
 * Subcommands surface:
 *   - `kobe`                    Launch the terminal workspace.
 *   - `kobe completions <shell> Generate shell completion script (bash/zsh/fish).
 *   - `kobe add [path]`         Save a repo path for the new-task picker.
 *   - `kobe remove [path]`      Forget a saved project (inverse of `add`; non-destructive).
 *   - `kobe adopt [glob]`       Import existing git worktrees as tasks.
 *   - `kobe export [--csv]`     Print the task list (json/csv/table; daemon-free).
 *   - `kobe api <verb>`         Scriptable RPC surface for agents (fan-out).
 *   - `kobe daemon <verb>`      Manage the long-lived daemon (start / stop / status / restart).
 *   - `kobe theme <verb>`       Manage user themes.
 *   - `kobe feedback`           Send feedback to GitHub Discussions.
 *   - `kobe update [target]`    Self-update (when packaged).
 *   - `kobe --version` / `-v`   Print version.
 *   - `kobe --help` / `-h`      Print usage.
 *
 * An unrecognized subcommand prints usage and exits non-zero (it does
 * NOT fall through to launching the TUI).
 *
 * `hook` is fired by an engine's own hooks inside a worktree to report
 * activity events.
 *
 * `kobe api send` delivers through the hosted PTY session controller.
 */
import { errorMessage } from "@/lib/error-message"
import { matchPathGlob } from "../lib/path-glob.ts"
import { expandTilde } from "../lib/path-home.ts"
import { type VendorId, coerceVendorId } from "../types/vendor.ts"
import type { AdoptableWorktree } from "../types/worktree.ts"
import { topLevelUsage } from "./usage.ts"

const ADD_USAGE =
  "Usage: kobe add [path]\n" +
  "       kobe add --remote --host <host> --user <user> --path <basePath> [--port N] [--key <path> | --password]\n\n" +
  "Save a repo for the new-task picker. With --remote, register an SSH-backed\n" +
  "project whose worktrees + engine run on <host> under <basePath>.\n"

async function runAddSubcommand(rest: readonly string[]): Promise<void> {
  const arg = rest[0]
  if (arg === "--help" || arg === "-h" || arg === "help") {
    process.stdout.write(ADD_USAGE)
    return
  }
  if (arg === "--remote") {
    const { runAddRemote } = await import("./add-remote.ts")
    await runAddRemote(rest.slice(1))
    return
  }
  if (arg?.startsWith("-")) {
    process.stderr.write(`kobe add: unknown flag "${arg}"\n\n${ADD_USAGE}`)
    process.exit(2)
  }
  const target = resolve(process.cwd(), expandTilde(arg && arg.length > 0 ? arg : "."))
  const { addSavedRepo, isGitRepo } = await import("../state/repos.ts")
  // A saved project must be a real local git repository — reject garbage
  // paths (e.g. `kobe add ,`, which resolves to a non-existent dir) before
  // they pollute the picker and become un-deletable synthetic rows.
  if (!isGitRepo(target)) {
    process.stderr.write(
      `kobe add: "${arg && arg.length > 0 ? arg : "."}" is not a git repository (resolved to ${target}).\n`,
    )
    process.exit(1)
  }
  const result = addSavedRepo(target)
  if (result.added) {
    console.log(`added ${result.path} (${result.total} saved repo${result.total === 1 ? "" : "s"} total)`)
  } else {
    console.log(`already saved: ${result.path}`)
  }
  // The sidebar's PROJECTS row IS the repo's `kind:"main"` task — create
  // it now (idempotent), via the daemon when one runs so a live TUI shows
  // the project immediately instead of only after a restart.
  await ensureProjectMainTask(result.path)
  // Fold in the repo's existing git worktrees: scan + adopt the ones not
  // yet linked to a task, most-recently-active first. A plain
  // repo with no extra worktrees imports nothing.
  await adoptAllWorktrees(result.path)
}

/** Ensure `repo`'s main task exists — over daemon RPC when running (the
 *  broadcast updates a live TUI's PROJECTS list), else through the
 *  one-shot local orchestrator. Best-effort: a failure must not block the
 *  add (worktree adoption below still runs). */
async function ensureProjectMainTask(repo: string): Promise<void> {
  const { connectIfRunning } = await import("@sma1lboy/kobe-daemon/client/daemon-process")
  const client = await connectIfRunning()
  try {
    if (client) {
      await client.request("task.ensureMain", { repo })
      return
    }
    const orch = await openLocalOrchestrator()
    await orch.ensureMainTask(repo)
  } catch (err) {
    console.error(`(skipped project main-task setup: ${errorMessage(err)})`)
  } finally {
    client?.close()
  }
}

const REMOVE_USAGE =
  "Usage: kobe remove [path]\n\n" +
  "Forget a saved project (drop it from the new-task picker). Non-destructive:\n" +
  "the repo's files, worktrees, branches and tasks all stay on disk. A remote\n" +
  "(ssh://) project also has its stored connection config dropped.\n\n" +
  "  path defaults to the current directory. Pass an exact saved entry (e.g. a\n" +
  "  remote `ssh://user@host` key) to remove it verbatim. Run with no match to\n" +
  "  print the current saved projects.\n"

/**
 * `kobe remove [path]` — the inverse of `kobe add`: forget a saved project.
 *
 * Matching is forgiving because the stored entries are git-toplevel absolute
 * paths (or synthetic `ssh://` keys for remote projects), while the user may
 * type a relative path, a subdirectory, or the exact stored string. We try, in
 * order: an exact match against the saved list (so a literal/garbage entry like
 * `","` or a remote URL is removable verbatim), then the git-toplevel of the
 * resolved path, then the plain resolved absolute path. On no match we print the
 * saved list so the user can copy the exact entry to remove.
 */
async function runRemoveSubcommand(rest: readonly string[]): Promise<void> {
  const arg = rest[0]
  if (arg === "--help" || arg === "-h" || arg === "help") {
    process.stdout.write(REMOVE_USAGE)
    return
  }
  if (arg?.startsWith("-")) {
    process.stderr.write(`kobe remove: unknown flag "${arg}"\n\n${REMOVE_USAGE}`)
    process.exit(2)
  }
  const { getSavedRepos, resolveRepoRoot } = await import("../state/repos.ts")
  const saved = getSavedRepos()
  if (saved.length === 0) {
    console.log("no saved projects to remove.")
    return
  }
  const raw = arg && arg.length > 0 ? arg : "."
  // Candidate targets, most-specific first; the first one present in the saved
  // list wins. resolveRepoRoot shells git, so only compute it when needed.
  const target = saved.includes(raw)
    ? raw
    : (() => {
        const abs = resolve(process.cwd(), expandTilde(raw))
        const top = resolveRepoRoot(abs)
        if (saved.includes(top)) return top
        if (saved.includes(abs)) return abs
        return null
      })()
  if (target === null) {
    process.stderr.write(`kobe remove: "${raw}" is not a saved project.\n\nSaved projects:\n`)
    for (const p of saved) process.stderr.write(`  ${p}\n`)
    process.exit(1)
  }
  // forgetProject un-saves the repo AND drops the synthetic main task that
  // projects it into the sidebar — removeSavedRepo alone left an orphan main
  // row behind (it lives in the daemon-owned task index, not state.json).
  // Prefer a RUNNING daemon so a live TUI updates; fall back to in-process.
  const { connectIfRunning } = await import("@sma1lboy/kobe-daemon/client/daemon-process")
  const client = await connectIfRunning()
  try {
    if (client) await client.request("project.forget", { repo: target })
    else await (await openLocalOrchestrator()).forgetProject(target)
  } finally {
    client?.close()
  }
  const remaining = getSavedRepos().length
  console.log(`removed ${target} (${remaining} saved repo${remaining === 1 ? "" : "s"} left)`)
}

/**
 * Discover every unlinked git worktree of `repo` and adopt each as a
 * task (discovery sorts most-recently-active first). Used by `kobe add`
 * to fold a repo's worktrees in on the way.
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
    console.error(`(skipped worktree scan: ${errorMessage(err)})`)
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
 * no daemon is up. Never boots a daemon.
 */
async function adoptWorktreesInto(
  orch: Awaited<ReturnType<typeof openLocalOrchestrator>>,
  repo: string,
  list: readonly AdoptableWorktree[],
  vendor: VendorId,
): Promise<void> {
  const { connectIfRunning } = await import("@sma1lboy/kobe-daemon/client/daemon-process")
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
 * repo's existing git worktrees (including ones outside kobe-managed
 * roots) and import the ones not yet linked to a task
 *. No glob → dry-run listing. With a path glob → list matches;
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
  const repo = resolveRepoRoot(resolve(process.cwd(), expandTilde(repoArg && repoArg.length > 0 ? repoArg : ".")))
  const vendor = coerceVendorId(vendorArg)

  // Discovery is a local read (git + tasks.json) — no daemon needed, so
  // listing never boots one.
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

async function main(): Promise<void> {
  const [, , ...rawArgs] = process.argv
  const [subcommand, ...rest] = rawArgs

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
    await runAddSubcommand(rest)
    return
  }
  if (subcommand === "remove") {
    await runRemoveSubcommand(rest)
    return
  }
  if (subcommand === "completions") {
    const { runCompletionsSubcommand } = await import("./completions-cmd.ts")
    await runCompletionsSubcommand(rest)
    return
  }
  if (subcommand === "adopt") {
    await runAdoptSubcommand(rest)
    return
  }
  if (subcommand === "export") {
    const { runExportSubcommand } = await import("./export-cmd.ts")
    await runExportSubcommand(rest)
    return
  }
  if (subcommand === "repo") {
    const { runRepoSubcommand } = await import("./repo-cmd.ts")
    await runRepoSubcommand(rest)
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
  if (subcommand === "feedback") {
    const { runFeedbackSubcommand } = await import("./feedback-cmd.ts")
    await runFeedbackSubcommand(rest)
    return
  }
  if (subcommand === "daemon") {
    const { runDaemonSubcommand } = await import("./daemon-cmd.ts")
    await runDaemonSubcommand(rest)
    return
  }
  if (subcommand === "doctor") {
    const { runDoctorSubcommand } = await import("./doctor-cmd.ts")
    await runDoctorSubcommand(rest)
    return
  }
  if (subcommand === "config") {
    const { runConfigSubcommand } = await import("./config-cmd.ts")
    await runConfigSubcommand(rest)
    return
  }
  if (subcommand === "reset") {
    const { runResetSubcommand } = await import("./reset-cmd.ts")
    await runResetSubcommand(rest)
    return
  }
  if (subcommand === "pty-host") {
    // Internal (spawned detached by the terminal pane's
    // ensurePtyHostReachable): the standalone process that owns embedded
    // terminal PTYs so they survive TUI exits and daemon restarts.
    const { runPtyHostSubcommand } = await import("./pty-host-cmd.ts")
    await runPtyHostSubcommand(rest)
    return
  }
  if (subcommand === "web") {
    const { runWebSubcommand } = await import("./web-cmd.ts")
    await runWebSubcommand(rest)
    return
  }
  if (subcommand === "skill") {
    // Install / inspect the kobe agent skill that ships in this package.
    const { runSkillSubcommand } = await import("./skill-cmd.ts")
    await runSkillSubcommand(rest)
    return
  }
  if (subcommand === "hook") {
    // Internal: fired by an engine's hooks inside a task worktree to report a
    // normalized activity event to the daemon (event-driven task state).
    // Always exits 0; never spawns the daemon.
    const { runHookSubcommand } = await import("./hook-cmd.ts")
    await runHookSubcommand(rest)
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

  // Own the terminal title before the first-run gate: onboarding is itself
  // an interactive Kobe UI and may return without ever calling startTui().
  const { publishKobeTerminalTitle } = await import("../tui/lib/outer-terminal-title.ts")
  publishKobeTerminalTitle()

  // First interactive launch → the inline onboarding wizard instead of the
  // TUI (it ends with "run `kobe`"; the next launch lands in the app).
  const { maybeRunOnboarding } = await import("./onboarding.ts")
  if (await maybeRunOnboarding()) return

  // Default: launch the TUI. Dynamic import so non-TUI subcommands
  // (like `kobe add`) don't pull in opentui/solid at startup.
  const { startTui } = await import("../tui/index.tsx")
  await startTui()
}

main().catch((err) => {
  console.error("kobe failed to start:", process.env.KOBE_DEBUG === "1" ? err : errorMessage(err))
  process.exit(1)
})
