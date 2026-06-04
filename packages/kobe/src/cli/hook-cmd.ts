/**
 * `kobe hook <verb> --task-id <id>` — INTERNAL subcommand fired by an engine's
 * hooks (e.g. Claude Code's Stop / StopFailure / Notification), installed into
 * a task's worktree by the engine hook adapter. It reports a NORMALIZED
 * activity event to the daemon, which folds it into the task's transient
 * engine-state and broadcasts it (event-driven task badges).
 *
 * Contract (load-bearing):
 *  - **Never spawns the daemon.** A hook may fire while the user is detached
 *    (no gui) and the daemon has idle-stopped; resurrecting a gui-less daemon
 *    would break the refcounted lazy-shutdown. If no daemon is running the
 *    event is simply dropped (best-effort; the activity badge lapses to idle
 *    and the polling fallback still covers it).
 *  - **Always exits 0.** A non-zero hook exit is at best logged and at worst
 *    (WorktreeCreate) FAILS the engine's action — never acceptable for an
 *    observability hook. Every failure path here is swallowed.
 *
 * `verb` is already vendor-neutral (the engine adapter did the translation);
 * extra detail (failure class, waiting reason) is read from the hook's stdin
 * JSON payload.
 */

import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { connectIfRunning } from "../client/daemon-process.ts"
import { createEngineHookAdapter } from "../engine/hook-adapter.ts"
import type { EngineActivityDetail } from "../engine/hook-events.ts"
import { isEngineActivityKind } from "../engine/hook-events.ts"
import { getPersistedString, setPersistedString } from "../state/repos.ts"
import { ALL_VENDORS } from "../types/vendor.ts"

/** Read the hook's stdin JSON payload (Claude Code pipes it), bounded so a
 *  manual invocation without stdin can't hang. Returns {} on anything odd. */
async function readStdinPayload(): Promise<Record<string, unknown>> {
  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((resolve) => setTimeout(() => resolve(""), 500)),
    ])
    if (!text.trim()) return {}
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Map a Claude StopFailure `error_type` to the neutral failure class. */
function failureFromErrorType(errorType: unknown): EngineActivityDetail["failure"] {
  if (typeof errorType !== "string") return "other"
  if (errorType === "rate_limit" || errorType === "overloaded") return "rate_limit"
  if (errorType === "billing_error") return "billing"
  return "other"
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1]
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1)
  }
  return undefined
}

export async function runHookSubcommand(argv: readonly string[]): Promise<void> {
  const [verb, ...rest] = argv
  // `setup` is the only user-facing verb (opt-in worktree-sync install) and
  // may print/exit non-zero on a usage error. Everything else is a hook
  // callback: best-effort, always exit 0 (see header).
  if (verb === "setup") {
    await runHookSetup(rest)
    return
  }
  try {
    if (verb === "worktree-created") {
      await reportWorktreeCreated()
      return
    }
    if (!verb || !isEngineActivityKind(verb)) return // unknown verb → drop silently
    const taskId = flagValue(rest, "--task-id")
    if (!taskId) return

    const payload = await readStdinPayload()
    let detail: EngineActivityDetail | undefined
    if (verb === "turn-failed") {
      detail = { failure: failureFromErrorType(payload.error_type) }
    } else if (verb === "awaiting-input") {
      // The only awaiting-input hook kobe installs is the permission matcher.
      detail = { waiting: "permission" }
    }

    const client = await connectIfRunning() // NON-spawning by contract
    if (!client) return
    try {
      await client.request("engine.reportEvent", { taskId, kind: verb, ...(detail ? { detail } : {}) })
    } finally {
      client.close()
    }
  } catch {
    /* swallow — hooks must never fail the engine */
  }
}

/**
 * `kobe hook worktree-created` — fired by the WorktreeCreate hook when an
 * engine creates a worktree OUTSIDE kobe (`claude --worktree`). Reads the
 * worktree path from the hook's stdin payload, derives the repo, and asks the
 * daemon to adopt it as a Task (idempotent — a worktree kobe already tracks is
 * a no-op). NON-spawning + always exit 0 (a non-zero exit would FAIL the
 * engine's worktree creation).
 */
async function reportWorktreeCreated(): Promise<void> {
  const payload = await readStdinPayload()
  const worktreePath = typeof payload.worktree_path === "string" ? payload.worktree_path : undefined
  if (!worktreePath) return
  const repo = await deriveRepoRoot(worktreePath)
  if (!repo) return
  const client = await connectIfRunning() // NON-spawning
  if (!client) return
  try {
    await client.request("worktree.adopt", { repo, worktreePath, ifExists: "return" })
  } finally {
    client.close()
  }
}

/** Main repo root for a worktree: parent of its git-common-dir (`/repo/.git` → `/repo`). */
async function deriveRepoRoot(worktreePath: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["git", "-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    if (code !== 0) return undefined
    const commonDir = out.trim()
    return commonDir ? dirname(commonDir) : undefined
  } catch {
    return undefined
  }
}

const SYNC_SETTING_KEY = "externalWorktreeSync"

/** Settings file an engine's worktree-sync hook is written into, per scope. */
function syncSettingsPath(scope: { kind: "global" } | { kind: "repo"; path: string }): string {
  if (scope.kind === "repo") return join(resolve(scope.path), ".claude", "settings.json")
  // GLOBAL = the OS home's ~/.claude (where Claude Code reads user settings),
  // NOT kobe's KOBE_HOME_DIR.
  return join(homedir(), ".claude", "settings.json")
}

/** Engines that can create worktrees outside kobe (only Claude today). */
function worktreeSyncAdapters() {
  return ALL_VENDORS.map((v) => createEngineHookAdapter(v)).filter((a) => a.supportsWorktreeSync())
}

/**
 * `kobe hook setup [--global | --repo <path> | --off]` — opt-in install of the
 * worktree-sync hook so external `claude --worktree`s sync into kobe. Writes
 * the chosen scope into state.json and the hook into the matching settings
 * file. `--off` removes whatever was installed.
 */
async function runHookSetup(argv: readonly string[]): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      [
        "Usage: kobe hook setup [--global | --repo <path> | --off]",
        "",
        "Install (or remove with --off) the hook that syncs an external",
        "`claude --worktree` into kobe as a task. Default: --global (~/.claude).",
        "",
      ].join("\n"),
    )
    return
  }

  const off = argv.includes("--off")
  const repoIdx = argv.indexOf("--repo")
  const repoPath = repoIdx !== -1 ? argv[repoIdx + 1] : undefined
  if (repoIdx !== -1 && !repoPath) {
    process.stderr.write("kobe hook setup: --repo requires a path\n")
    process.exit(2)
  }

  const adapters = worktreeSyncAdapters()
  if (adapters.length === 0) {
    process.stdout.write("kobe hook setup: no engine supports external worktree sync — nothing to do\n")
    return
  }

  if (off) {
    // Remove from wherever it was previously installed (persisted scope).
    const prev = getPersistedString(SYNC_SETTING_KEY)
    const path = prev?.startsWith("repo:")
      ? syncSettingsPath({ kind: "repo", path: prev.slice(5) })
      : syncSettingsPath({ kind: "global" })
    for (const a of adapters) await a.removeWorktreeSyncHook(path)
    setPersistedString(SYNC_SETTING_KEY, "off")
    process.stdout.write(`kobe hook setup: external worktree sync disabled (removed from ${path})\n`)
    return
  }

  const scope: { kind: "global" } | { kind: "repo"; path: string } = repoPath
    ? { kind: "repo", path: repoPath }
    : { kind: "global" }
  const path = syncSettingsPath(scope)
  for (const a of adapters) await a.installWorktreeSyncHook(path)
  setPersistedString(SYNC_SETTING_KEY, scope.kind === "repo" ? `repo:${resolve(scope.path)}` : "global")
  process.stdout.write(
    [
      `kobe hook setup: external worktree sync enabled (${scope.kind}) — wrote ${path}`,
      "New `claude --worktree` worktrees will appear as kobe tasks.",
      "",
    ].join("\n"),
  )
}
