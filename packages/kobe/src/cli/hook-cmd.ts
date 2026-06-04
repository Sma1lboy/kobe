/**
 * `kobe hook <verb>` — INTERNAL subcommand fired by an engine's hooks (e.g.
 * Claude Code's Stop / StopFailure / Notification), installed GLOBALLY into the
 * user's `~/.claude/settings.json` by the engine hook adapter. It reports a
 * NORMALIZED activity event to the daemon, which maps the hook's cwd to a task
 * (`daemon/cwd-task.ts`), folds it into that task's transient engine-state, and
 * broadcasts it (event-driven task badges).
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

    const payload = await readStdinPayload()
    // The global hook carries no task id — it reports the cwd it ran in, and
    // the daemon maps that to a task by worktree path. Claude pipes `cwd` in
    // the payload; fall back to the process cwd. `--task-id` is still honoured
    // for back-compat / direct invocation.
    const taskId = flagValue(rest, "--task-id")
    const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd()
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
      await client.request("engine.reportEvent", {
        ...(taskId ? { taskId } : { cwd }),
        kind: verb,
        ...(detail ? { detail } : {}),
      })
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
  return globalSettingsPath()
}

/** Engines that can create worktrees outside kobe (only Claude today). */
function worktreeSyncAdapters() {
  return ALL_VENDORS.map((v) => createEngineHookAdapter(v)).filter((a) => a.supportsWorktreeSync())
}

/** Engines whose hook mechanism is wired (get global activity hooks). */
function activityHookAdapters() {
  return ALL_VENDORS.map((v) => createEngineHookAdapter(v)).filter((a) => a.supportsHooks())
}

/** Where kobe's GLOBAL activity hooks live (the OS home's ~/.claude, where
 *  Claude Code reads user settings — NOT kobe's KOBE_HOME_DIR). */
function globalSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json")
}

/** Resolve a persisted sync setting to the settings-file path it points at, or
 *  undefined when off/unset. Accepts the current form (an absolute path) AND
 *  the older `global` / `repo:<path>` forms for back-compat. */
function persistedSyncPath(stored: string | undefined): string | undefined {
  if (!stored || stored === "off") return undefined
  if (stored === "global") return syncSettingsPath({ kind: "global" })
  if (stored.startsWith("repo:")) return syncSettingsPath({ kind: "repo", path: stored.slice(5) })
  return stored // already a resolved path
}

/**
 * Default-ON global hook install (KOB). Called once per kobe launch. Two pieces,
 * both into the user's global `~/.claude/settings.json`, both idempotent (the
 * adapter skips the write when already in place) and best-effort:
 *
 *  1. **Activity hooks** — Stop / StopFailure / Notification / … so EVERY Claude
 *     session reports normalized events; the daemon maps each hook's cwd to a
 *     task. Always global (a task's badge must light up wherever its engine
 *     runs), so this is not scope-configurable.
 *  2. **Worktree-sync hook** — `WorktreeCreate` so an external `claude
 *     --worktree` syncs into kobe out of the box. Honours an existing scope
 *     choice (`--repo`) and the `--off` opt-out.
 *
 * Writing the user's global settings.json is intentionally invasive but
 * acceptable for now (current users are developers).
 */
export async function ensureGlobalKobeHooks(): Promise<void> {
  try {
    // 1. Activity hooks — always global, no opt-out toggle today.
    const globalPath = globalSettingsPath()
    for (const a of activityHookAdapters()) await a.installActivityHooks(globalPath)

    // 2. Worktree sync — respects the persisted scope / --off.
    const stored = getPersistedString(SYNC_SETTING_KEY)
    if (stored === "off") return // user opted out of sync — respect it
    const syncAdapters = worktreeSyncAdapters()
    if (syncAdapters.length === 0) return
    const path = persistedSyncPath(stored) ?? syncSettingsPath({ kind: "global" })
    for (const a of syncAdapters) await a.installWorktreeSyncHook(path)
    if (!stored) setPersistedString(SYNC_SETTING_KEY, path) // remember where, so --off can clean it
  } catch {
    /* best-effort — never block launch */
  }
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
        "Syncs an external `claude --worktree` into kobe as a task. This is ON",
        "by default (installed globally into ~/.claude on launch). Use this to",
        "move it to one repo (--repo <path>) or to turn it OFF (--off).",
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

  // Where the hook was LAST installed (we persist the resolved path, so --off
  // and a scope-switch always find the right file to clean — no orphaned hook).
  const prevPath = persistedSyncPath(getPersistedString(SYNC_SETTING_KEY))

  if (off) {
    if (prevPath) {
      for (const a of adapters) await a.removeWorktreeSyncHook(prevPath)
    }
    setPersistedString(SYNC_SETTING_KEY, "off")
    process.stdout.write(
      `kobe hook setup: external worktree sync disabled${prevPath ? ` (removed from ${prevPath})` : ""}\n`,
    )
    return
  }

  const scope: { kind: "global" } | { kind: "repo"; path: string } = repoPath
    ? { kind: "repo", path: repoPath }
    : { kind: "global" }
  const path = syncSettingsPath(scope)
  // Switching scope (e.g. global → repo): remove the hook from the OLD path
  // first so the previous location isn't left with an orphaned kobe hook.
  if (prevPath && prevPath !== path) {
    for (const a of adapters) await a.removeWorktreeSyncHook(prevPath)
  }
  for (const a of adapters) await a.installWorktreeSyncHook(path)
  setPersistedString(SYNC_SETTING_KEY, path)
  process.stdout.write(
    [
      `kobe hook setup: external worktree sync enabled (${scope.kind}) — wrote ${path}`,
      "New `claude --worktree` worktrees will appear as kobe tasks.",
      "",
    ].join("\n"),
  )
}
