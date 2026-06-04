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
import { join, resolve } from "node:path"
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
  // `setup` is the only user-facing verb (now a deprecated cleanup) and may
  // print on a usage error. Everything else is a hook callback: best-effort,
  // always exit 0 (see header).
  if (verb === "setup") {
    await runHookSetup(rest)
    return
  }
  try {
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

const SYNC_SETTING_KEY = "externalWorktreeSync"

/** Engines that once installed a WorktreeCreate hook (only Claude) — used now
 *  only to CLEAN UP that removed hook. */
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

/** Resolve a persisted sync setting to the settings-file path the old
 *  WorktreeCreate hook was written into (so cleanup finds it), or undefined when
 *  off/unset. Accepts the current form (an absolute path) AND the older
 *  `global` / `repo:<path>` forms for back-compat. */
function persistedSyncPath(stored: string | undefined): string | undefined {
  if (!stored || stored === "off") return undefined
  if (stored === "global") return globalSettingsPath()
  if (stored.startsWith("repo:")) return join(resolve(stored.slice(5)), ".claude", "settings.json")
  return stored // already a resolved path
}

/**
 * Default-ON global hook install (KOB). Called once per kobe launch. Two pieces,
 * both best-effort and idempotent (the adapter skips the write when nothing
 * changes):
 *
 *  1. **Activity hooks** — Stop / StopFailure / Notification / Session* into the
 *     user's global `~/.claude/settings.json`, so EVERY Claude session reports
 *     normalized events; the daemon maps each hook's cwd to a task. Always
 *     global (a task's badge must light up wherever its engine runs).
 *  2. **WorktreeCreate cleanup** — earlier kobe (0.7.4–0.7.9) installed a global
 *     `WorktreeCreate` hook for external-worktree sync. That was WRONG:
 *     `WorktreeCreate` is a VCS *provider* hook — its mere presence makes Claude
 *     Code delegate worktree creation to it and skip the native git path, so
 *     kobe's observer hook (which returns no path) BROKE `claude --worktree` /
 *     `EnterWorktree` in every repo. We now remove any such hook we ever wrote.
 *     External-worktree sync is reborn on the daemon side: a `session-start`
 *     whose cwd is an unadopted worktree under a tracked repo is auto-adopted
 *     (see `daemon/cwd-task.ts` `findAdoptableWorktree`) — no hook, no footgun.
 *
 * Writing the user's global settings.json is intentionally invasive but
 * acceptable for now (current users are developers).
 */
export async function ensureGlobalKobeHooks(): Promise<void> {
  try {
    // 1. Activity hooks — always global.
    const globalPath = globalSettingsPath()
    for (const a of activityHookAdapters()) await a.installActivityHooks(globalPath)
    // 2. Remove the removed WorktreeCreate hook wherever it was ever written.
    await cleanupWorktreeSyncHook()
  } catch {
    /* best-effort — never block launch */
  }
}

/**
 * Remove kobe's old `WorktreeCreate` hook from the global settings AND any repo
 * path it was persisted to, then mark the setting off so we don't rescan. Pure
 * cleanup — merge-safe (preserves the user's own WorktreeCreate hooks).
 */
async function cleanupWorktreeSyncHook(): Promise<void> {
  const adapters = worktreeSyncAdapters()
  if (adapters.length === 0) return
  const stored = getPersistedString(SYNC_SETTING_KEY)
  const paths = new Set<string>([globalSettingsPath()])
  const prev = persistedSyncPath(stored)
  if (prev) paths.add(prev)
  for (const a of adapters) for (const p of paths) await a.removeWorktreeSyncHook(p)
  if (stored !== "off") setPersistedString(SYNC_SETTING_KEY, "off")
}

/**
 * `kobe hook setup` — DEPRECATED. The external-worktree-sync it configured used
 * a global `WorktreeCreate` hook that broke `claude --worktree` / `EnterWorktree`
 * in every repo (see {@link ensureGlobalKobeHooks}). The command now only cleans
 * up any previously-installed hook; sync is automatic on the daemon side.
 */
async function runHookSetup(_argv: readonly string[]): Promise<void> {
  await cleanupWorktreeSyncHook()
  process.stdout.write(
    [
      "kobe hook setup is deprecated and now a no-op (cleanup only).",
      "",
      "The old external-worktree sync used a global WorktreeCreate hook, which is",
      "a VCS provider hook — its presence broke `claude --worktree` / EnterWorktree",
      "in every repo. Any hook kobe previously installed has been removed.",
      "",
      "Sync is now automatic: a `claude --worktree` (or any session) started in a",
      "worktree under a repo kobe already tracks is adopted as a task on launch.",
      "To adopt existing worktrees on demand, use the New Task dialog or `kobe adopt`.",
      "",
    ].join("\n"),
  )
}
