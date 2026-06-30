#!/usr/bin/env bun
/**
 * kobe CLI entry point (v0.6).
 *
 * Subcommands surface:
 *   - `kobe`                    Launch the TUI (default).
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
 *   - `kobe doctor`             Diagnose daemon / tmux / state (read-only).
 *   - `kobe reset [--hard]`     Recover a wedged install: stop daemon +
 *                               kill sessions (+ wipe state with --hard).
 *   - `kobe reload`             Restart Tasks/Ops panes in place (engine
 *                               panes untouched) to pick up new kobe code.
 *   - `kobe kill-sessions`      Tear down kobe's tmux server (dev reset).
 *   - `kobe --version` / `-v`   Print version.
 *   - `kobe --help` / `-h`      Print usage.
 *
 * An unrecognized subcommand prints usage and exits non-zero (it does
 * NOT fall through to launching the TUI).
 *
 * Internal subcommands fired by tmux key bindings inside a task session
 * (not meant for direct use): `new-chattab`, `quick-create`, `quick-task`,
 * `focus-tasks`, `heal-layout`, `capture-layout`, `layout`, `tasks`, `ops` —
 * each takes the session/worktree as flags.
 * `hook` is fired by an engine's own hooks inside a worktree to report
 * activity events.
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
  const target = resolve(process.cwd(), arg && arg.length > 0 ? arg : ".")
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
  // Fold in the repo's existing git worktrees: scan + adopt the ones not
  // yet linked to a task, most-recently-active first (KOB-256). A plain
  // repo with no extra worktrees imports nothing.
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
        const abs = resolve(process.cwd(), raw)
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
  /** Default repo to pre-select (used by `new-task`). */
  repo?: string
  /** Initial task row to select when a tmux Tasks pane starts. */
  initialTaskId?: string
  /** Internal layout action, used by `kobe layout`. */
  action?: string
  /** tmux window id, used by `kobe layout --action chat-tab-close`. */
  windowId?: string
  /** Client terminal width (cells), used by `kobe resync-window`. */
  cols?: string
  /** Client terminal height (cells), used by `kobe resync-window`. */
  rows?: string
  /** tmux `#{status}` value of the resized client, used by `kobe resync-window`. */
  status?: string
  /** tmux client name, used by `kobe resync-window`. */
  client?: string
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
    } else if (flag === "--repo") {
      flags.repo = value
      i++
    } else if (flag === "--initial-task-id") {
      flags.initialTaskId = value
      i++
    } else if (flag === "--action") {
      flags.action = value
      i++
    } else if (flag === "--window") {
      flags.windowId = value
      i++
    } else if (flag === "--cols") {
      flags.cols = value
      i++
    } else if (flag === "--rows") {
      flags.rows = value
      i++
    } else if (flag === "--status") {
      flags.status = value
      i++
    } else if (flag === "--client") {
      flags.client = value
      i++
    }
  }
  return flags
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
    // Hot-reload the in-tmux Tasks/Ops panes across all sessions WITHOUT a
    // reset: respawn only the kobe-owned helper panes (engine panes stay
    // alive). Use after changing kobe TUI-layer code.
    const { runReloadSubcommand } = await import("./maintenance.ts")
    await runReloadSubcommand(rest)
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
    // Ctrl+T / Ctrl+Shift+T fire from the session-global root table, so they
    // reach surface pages (new-task / settings / …) too — where opening a new
    // chat tab would yank the user off a half-filled dialog. No-op there.
    const { windowIsSurface } = await import("../tmux/client.ts")
    if (await windowIsSurface(session)) return
    let vendor: VendorId | undefined
    if (flags.vendor !== undefined) {
      // Accept any built-in (claude/codex/copilot) OR a registered custom
      // engine id (Settings → Engines). A genuine typo is rejected — but
      // VISIBLY: this runs under tmux `run-shell`, so a bare `process.exit(2)`
      // produces no new tab and no feedback. Surface the error via tmux
      // `display-message` so the user sees "unknown engine '…'" instead of
      // silence (the engine-choice prompt now ends with `…`, implying the list
      // is open, so a custom id is a legitimate entry).
      const typed = flags.vendor.trim()
      const { getCustomEngineIds } = await import("../state/repos.ts")
      const { isBuiltinVendor } = await import("../types/vendor.ts")
      const accepted = isBuiltinVendor(typed) || getCustomEngineIds().includes(typed)
      if (!accepted) {
        const knownList = [...ALL_VENDORS, ...getCustomEngineIds()].join(", ")
        const msg = `kobe: unknown engine '${typed}' (known: ${knownList})`
        const { runTmux } = await import("../tmux/client.ts")
        await runTmux(["display-message", "-t", session, msg])
        console.error(msg)
        process.exit(2)
      }
      vendor = typed as VendorId
      // An explicit engine pick (Ctrl+Shift+T / prefix T → engine prompt) sets
      // the DEFAULT engine for new tasks too — `lastSelectedVendor` is the one
      // reference the new-task dialog, quick-task, and Settings → Engines all
      // read/show. Without this, picking an engine for a chat tab silently left
      // the default untouched.
      const { setPersistedString } = await import("../state/repos.ts")
      setPersistedString("lastSelectedVendor", vendor)
    }
    const { newChatTab } = await import("../tui/panes/terminal/tmux.ts")
    await newChatTab(session, vendor)
    return
  }
  if (subcommand === "engine-tab-exit") {
    // Fired from an engine pane's keepAlive `onExit` (see engineTabExitCleanup)
    // after the user exits the post-engine fallback shell. Closes this chat tab,
    // or — when it's the task's only tab — replaces it with a fresh engine tab so
    // the task session never goes empty. Reads the baked-in `--session`.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe engine-tab-exit: --session <name> is required")
      process.exit(2)
    }
    const { engineTabExit } = await import("../tui/panes/terminal/layout-actions.ts")
    await engineTabExit(session)
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
  if (subcommand === "focus-tasks") {
    // First stage of two-stage Ctrl+Q from inside a task's tmux session:
    // focus the current window's Tasks pane, restoring it first if the rail is
    // hidden. The if-shell binding invokes this only when it should not detach
    // directly. Reads `--session` plus the source `--window` when fired by tmux.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe focus-tasks: --session <name> is required")
      process.exit(2)
    }
    const { windowIsSurface } = await import("../tmux/client.ts")
    // Ctrl+Q's else-branch (back-to-tasks) reaches surface pages too — a
    // surface window has no Tasks pane and the user is mid-dialog, so no-op.
    if (flags.windowId && (await windowIsSurface(flags.windowId))) return
    const { selectTasksPane } = await import("../tui/panes/terminal/tmux.ts")
    await selectTasksPane(session, { windowId: flags.windowId })
    return
  }
  if (subcommand === "heal-layout") {
    // `window-resized` + `pane-exited` tmux hook handler: re-pin the session's
    // Tasks-rail width + right-column geometry to the shared globals. Fixes the
    // first-attach reflow (the first session is built before any client is
    // attached, so tmux reflows its panes when `attach` lands the real terminal
    // size), any live terminal resize, and the pane-close reflow (exiting a
    // workspace-split terminal hands its cells to a neighbour, knocking the rail /
    // right column off their pinned geometry). No-op for the home/role-less
    // session. Reads `--session`.
    //
    // A live resize fires this hook many times in a burst; `coalesceLayoutWork`
    // trailing-debounces so the burst collapses to ONE heal (no concurrent
    // `-b` thrash, no per-event tmux round-trip storm). The pre-attach heal in
    // `prepareWindowForAttach` is a DIRECT call, so the first frame is still
    // synchronous — the debounce only affects the live-resize hook path.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe heal-layout: --session <name> is required")
      process.exit(2)
    }
    const { healSessionLayout } = await import("../tui/panes/terminal/tmux.ts")
    const { coalesceLayoutWork } = await import("../tui/panes/terminal/layout-coord.ts")
    await coalesceLayoutWork(session, "heal", () => healSessionLayout(session))
    return
  }
  if (subcommand === "resync-window") {
    // `client-resized` tmux hook handler: re-pin the active window to the size of
    // the client whose terminal just changed, then heal the rail. Covers the GROW
    // direction that `window-resized` / `heal-layout` miss — the pre-attach
    // `resize-window` left the window in `manual` sizing, so a live terminal grow
    // never fires `window-resized` (see resyncWindowToClient). Client dims arrive
    // as args; coalesced so a resize-drag's event burst collapses to one re-pin.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe resync-window: --session <name> is required")
      process.exit(2)
    }
    const cols = Number.parseInt(flags.cols ?? "", 10)
    const rows = Number.parseInt(flags.rows ?? "", 10)
    const size =
      Number.isInteger(cols) && cols > 0 && Number.isInteger(rows) && rows > 0 ? { columns: cols, rows } : null
    const { resyncWindowToClient } = await import("../tui/panes/terminal/tmux.ts")
    const { coalesceLayoutWork } = await import("../tui/panes/terminal/layout-coord.ts")
    await coalesceLayoutWork(session, "resync", () =>
      resyncWindowToClient(session, { size, status: flags.status, clientName: flags.client }),
    )
    return
  }
  if (subcommand === "capture-layout") {
    // `window-layout-changed` tmux hook handler: persist a manual rail /
    // right-column drag into the shared global the moment it happens, so a
    // later terminal resize (whose `heal-layout` re-pins to the global) can't
    // discard a drag the user hadn't yet committed by switching tasks.
    //
    // `window-layout-changed` ALSO fires on a terminal-resize reflow (and on
    // the heal's own `resize-pane`), where the rail is proportionally blown up
    // and must NOT be captured. The `genAgeMs(..., "resize")` guard skips
    // capture while a resize/heal is in flight — every heal path stamps the
    // `resize` recency marker (healWorkspaceLayout + the pre-switch/attach
    // resizes), not just the coalesced hook. `captureGlobalLayoutOnDrag`'s own
    // gate excludes zoom / half-built layouts.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe capture-layout: --session <name> is required")
      process.exit(2)
    }
    const { captureGlobalLayoutOnDrag } = await import("../tui/panes/terminal/tmux.ts")
    const { coalesceLayoutWork, genAgeMs, RESIZE_GUARD_MS } = await import("../tui/panes/terminal/layout-coord.ts")
    await coalesceLayoutWork(session, "capture", async () => {
      // Re-check AFTER winning the debounce: a resize may have begun during the
      // trailing wait, in which case its heal owns the geometry — not us.
      if (genAgeMs(session, "resize") < RESIZE_GUARD_MS) return
      await captureGlobalLayoutOnDrag(session)
    })
    return
  }
  if (subcommand === "layout") {
    // Internal tmux session layout controls fired by prefix layout bindings.
    // Reads `--session`, source `--window`, and a narrow `--action` enum so
    // async run-shell handlers act on the ChatTab where the key was pressed.
    const flags = parseOpsFlags(rest)
    const session = flags.session
    if (!session) {
      console.error("kobe layout: --session <name> is required")
      process.exit(2)
    }
    const action = flags.action
    const valid = new Set([
      "workspace-split",
      "workspace-close",
      "workspace-reset",
      "tasks-toggle",
      "tasks-restore",
      "ops-toggle",
      "terminal-toggle",
      "zen-toggle",
      "chat-tab-close",
    ])
    if (!action || !valid.has(action)) {
      console.error(
        "kobe layout: --action must be one of workspace-split, workspace-close, workspace-reset, tasks-toggle, tasks-restore, ops-toggle, terminal-toggle, zen-toggle, chat-tab-close",
      )
      process.exit(2)
    }
    const { runLayoutAction } = await import("../tui/panes/terminal/tmux.ts")
    await runLayoutAction(session, action as import("../tui/panes/terminal/tmux.ts").LayoutAction, {
      windowId: flags.windowId,
    })
    return
  }
  if (subcommand === "quick-task") {
    // The prompt-only quick-create page, opened in its own window by
    // `quickCreate` (the `<prefix> f` / `kobe quick-create` handler). Asks
    // for only a prompt and fills the rest from the firing task's defaults.
    // Reads `--session` to resolve those defaults.
    const flags = parseOpsFlags(rest)
    const { startQuickTaskHost } = await import("../tui/quick-task/host.tsx")
    await startQuickTaskHost({ session: flags.session })
    return
  }
  if (subcommand === "tasks") {
    // Experimental Tasks pane (left side of a task's tmux session) —
    // a read-only task list that `switch-client`s between sessions.
    const flags = parseOpsFlags(rest)
    const { startTasksPane } = await import("../tui/tasks-pane/host.tsx")
    await startTasksPane({ initialTaskId: flags.initialTaskId })
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
  if (subcommand === "help-page") {
    // The F1 keybindings help as a standalone full-window surface
    // (distinct from `kobe help`, which prints CLI usage). Opened by
    // `openHelpTab` as a new tmux window; reuses the same HelpDialog
    // the in-pane overlay uses.
    const { startHelpHost } = await import("../tui/help/host.tsx")
    await startHelpHost()
    return
  }
  if (subcommand === "new-task") {
    // The new-task flow as a standalone full-window page (the default
    // `chattab` settings surface). Opened by `openNewTaskTab`; reuses the
    // same NewTaskDialog the in-pane overlay uses and performs the
    // create/adopt against its own daemon connection before exiting.
    const flags = parseOpsFlags(rest)
    const { startNewTaskHost } = await import("../tui/new-task/host.tsx")
    await startNewTaskHost({ defaultRepo: flags.repo })
    return
  }
  if (subcommand === "update-page") {
    // Internal full-window update surface opened from the tmux-native
    // Tasks pane. `kobe update` remains the shell updater; this page
    // presents the version/release context and hands off to that updater.
    const { startUpdateHost } = await import("../tui/update/host.tsx")
    await startUpdateHost()
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
  await startTui()
}

main().catch((err) => {
  console.error("kobe failed to start:", err)
  process.exit(1)
})
