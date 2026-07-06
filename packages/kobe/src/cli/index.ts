#!/usr/bin/env bun
import { resolve } from "node:path"
import { matchPathGlob } from "../lib/path-glob.ts"
import { expandTilde } from "../lib/path-home.ts"
import { type VendorId, coerceVendorId } from "../types/vendor.ts"
import type { AdoptableWorktree } from "../types/worktree.ts"
import { dispatchTuiCommand } from "./commands-tui.ts"
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
  await adoptAllWorktrees(result.path)
}

const REMOVE_USAGE =
  "Usage: kobe remove [path]\n\n" +
  "Forget a saved project (drop it from the new-task picker). Non-destructive:\n" +
  "the repo's files, worktrees, branches and tasks all stay on disk. A remote\n" +
  "(ssh://) project also has its stored connection config dropped.\n\n" +
  "  path defaults to the current directory. Pass an exact saved entry (e.g. a\n" +
  "  remote `ssh://user@host` key) to remove it verbatim. Run with no match to\n" +
  "  print the current saved projects.\n"

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

async function openLocalOrchestrator() {
  const { TaskIndexStore } = await import("../orchestrator/index/store.ts")
  const { GitWorktreeManager } = await import("../orchestrator/worktree/manager.ts")
  const { Orchestrator } = await import("../orchestrator/core.ts")
  const store = new TaskIndexStore()
  await store.load()
  return new Orchestrator({ store, worktrees: new GitWorktreeManager() })
}

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
      adoptUsageError(`unexpected argument "${a}"`)
    }
  }

  const { resolveRepoRoot } = await import("../state/repos.ts")
  const repo = resolveRepoRoot(resolve(process.cwd(), expandTilde(repoArg && repoArg.length > 0 ? repoArg : ".")))
  const vendor = coerceVendorId(vendorArg)

  const orch = await openLocalOrchestrator()
  const worktrees = await orch.discoverAdoptableWorktrees(repo)
  if (worktrees.length === 0) {
    console.log(`no adoptable worktrees for ${repo} — every git worktree here is already a task`)
    return
  }

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
    const { runDoctorSubcommand } = await import("./maintenance.ts")
    await runDoctorSubcommand(rest)
    return
  }
  if (subcommand === "web") {
    const { runWebSubcommand } = await import("./web-cmd.ts")
    await runWebSubcommand(rest)
    return
  }
  if (subcommand === "reset") {
    const { runResetSubcommand } = await import("./maintenance.ts")
    await runResetSubcommand(rest)
    return
  }
  if (subcommand === "reload") {
    const { runReloadSubcommand } = await import("./maintenance.ts")
    await runReloadSubcommand(rest)
    return
  }
  if (subcommand === "skill") {
    const { runSkillSubcommand } = await import("./skill-cmd.ts")
    await runSkillSubcommand(rest)
    return
  }
  if (subcommand === "hook") {
    const { runHookSubcommand } = await import("./hook-cmd.ts")
    await runHookSubcommand(rest)
    return
  }
  if (await dispatchTuiCommand(subcommand, rest)) return

  if (subcommand !== undefined) {
    console.error(`kobe: unknown command '${subcommand}'`)
    printTopLevelUsage(process.stderr)
    process.exit(2)
  }

  const { startTui } = await import("../tui/index.tsx")
  await startTui()
}

main().catch((err) => {
  console.error("kobe failed to start:", err)
  process.exit(1)
})
