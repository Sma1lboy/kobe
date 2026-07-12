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
import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { createEngineHookAdapter } from "../engine/hook-adapter.ts"
import type { EngineActivityDetail } from "../engine/hook-events.ts"
import { isEngineActivityKind } from "../engine/hook-events.ts"
import { getPersistedString, setPersistedString } from "../state/repos.ts"
import { ALL_VENDORS } from "../types/vendor.ts"

/** Default timeout for the stdin race — bounds a manual invocation without
 *  stdin so it can't hang. */
const STDIN_READ_TIMEOUT_MS = 500

/**
 * Race a text reader against a fallback timeout, returning "" if the timeout
 * wins. CRUCIALLY clears the timer the moment the race settles: an un-cleared
 * `setTimeout` stays pending and keeps the event loop alive for the full
 * `timeoutMs` after the work is already done. `kobe hook` runs on EVERY Bash
 * tool call + turn boundary of every Claude session machine-wide (it's the
 * global PostToolUse / activity hook), so a dangling 500ms timer added ~500ms
 * of pure idle wait to each of those invocations. Pure (reader + clock are the
 * only inputs) so the timer-hygiene contract is unit-testable without `Bun`.
 */
export async function readTextWithTimeout(
  read: () => Promise<string>,
  timeoutMs: number = STDIN_READ_TIMEOUT_MS,
): Promise<string> {
  let raceTimer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      read(),
      new Promise<string>((resolve) => {
        raceTimer = setTimeout(() => resolve(""), timeoutMs)
      }),
    ])
  } finally {
    if (raceTimer !== undefined) clearTimeout(raceTimer)
  }
}

/** Read the hook's stdin JSON payload (Claude Code pipes it), bounded so a
 *  manual invocation without stdin can't hang. Returns {} on anything odd. */
async function readStdinPayload(): Promise<Record<string, unknown>> {
  try {
    const text = await readTextWithTimeout(() => Bun.stdin.text())
    if (!text.trim()) return {}
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1]
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1)
  }
  return undefined
}

/** The verb of the global `PostToolUse` (Bash) hook that keeps tasks in sync
 *  with git-worktree lifecycle commands (adopt on `worktree add`, archive on
 *  `worktree remove`). Kept in sync with the engine adapter's
 *  `WORKTREE_SYNC_MARKER` (the command substring the hook is installed with). */
const WORKTREE_CREATED_VERB = "worktree-created"

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

/** Tokenize a shell command crudely: whitespace-split with single/double quote
 *  stripping. Good enough to locate a `git worktree add <path>`; anything it
 *  mis-tokenizes just yields no path → no adopt (best-effort, never throws). */
function tokenizeCommand(command: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec loop
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "")
  return out
}

/**
 * Extract the target path of a `git worktree add` from a (possibly compound)
 * shell command, or undefined when the command isn't a worktree-add. Finds the
 * first positional after the `worktree add` tokens, skipping flags and the
 * values of the value-taking flags (`-b` / `-B` / `--reason`). Stops at a shell
 * operator so a chained `&& rm -rf x` can't be mistaken for the path.
 */
export function parseWorktreeAddPath(command: string): string | undefined {
  const tokens = tokenizeCommand(command)
  const valueFlags = new Set(["-b", "-B", "--reason"])
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i] !== "worktree" || tokens[i + 1] !== "add") continue
    let j = i + 2
    while (j < tokens.length) {
      const t = tokens[j]
      if (t === "&&" || t === "||" || t === ";" || t === "|" || t === ">" || t === ">>") break
      if (t.startsWith("-")) {
        j += valueFlags.has(t) ? 2 : 1 // `--reason=x` (has `=`) is self-contained → skip 1
        continue
      }
      return t // first positional after the flags is the worktree path
    }
  }
  return undefined
}

/**
 * Extract the target path of a `git worktree remove` from a (possibly compound)
 * shell command, or undefined when the command isn't a worktree-remove. Mirrors
 * {@link parseWorktreeAddPath}: finds the first positional after the `worktree
 * remove` tokens, skipping flags (all of `remove`'s flags — `-f`/`--force` — are
 * valueless). Stops at a shell operator so a chained command can't be mistaken
 * for the path.
 */
export function parseWorktreeRemovePath(command: string): string | undefined {
  const tokens = tokenizeCommand(command)
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i] !== "worktree" || tokens[i + 1] !== "remove") continue
    let j = i + 2
    while (j < tokens.length) {
      const t = tokens[j]
      if (t === "&&" || t === "||" || t === ";" || t === "|" || t === ">" || t === ">>") break
      if (t.startsWith("-")) {
        j += 1 // `git worktree remove` takes only valueless flags (-f/--force)
        continue
      }
      return t // first positional after the flags is the worktree path
    }
  }
  return undefined
}

/**
 * `kobe hook worktree-created` — the global `PostToolUse` (Bash) callback. Reads
 * the hook payload and asks the daemon (non-spawning) to keep tasks in sync with
 * the two git-worktree lifecycle commands:
 *  - `git worktree add <path>`    → adopt the new worktree as a task.
 *  - `git worktree remove <path>` → archive the task pinned to that worktree.
 * Everything is best-effort + swallowed: a hook must never fail the engine.
 */
async function runWorktreeCreatedHook(): Promise<void> {
  const payload = await readStdinPayload()
  // Claude's PostToolUse payload carries the Bash command under `tool_input`.
  const toolInput = isPlainObject(payload.tool_input) ? payload.tool_input : {}
  const command = typeof toolInput.command === "string" ? toolInput.command : ""
  if (!command.includes("worktree")) return // cheap pre-filter: 99.9% of Bash calls bail here
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd()
  const addPath = parseWorktreeAddPath(command)
  const removePath = addPath ? undefined : parseWorktreeRemovePath(command)
  if (!addPath && !removePath) return
  const client = await connectIfRunning() // NON-spawning by contract
  if (!client) return
  try {
    if (addPath) {
      await client.request("worktree.reconcile", { cwd, worktreePath: resolve(cwd, addPath) })
    } else if (removePath) {
      await client.request("worktree.archiveRemoved", { worktreePath: resolve(cwd, removePath) })
    }
  } finally {
    client.close()
  }
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
  // Worktree lifecycle sync: the global `PostToolUse` (Bash) hook. Fires after
  // EVERY Bash tool call machine-wide, so it must no-op fast — it only touches
  // the daemon when the command was a `git worktree add`/`remove`.
  if (verb === WORKTREE_CREATED_VERB) {
    try {
      await runWorktreeCreatedHook()
    } catch {
      /* swallow — hooks must never fail the engine */
    }
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
    // Tab identity: engine tabs launch as `env KOBE_TASK_ID=… KOBE_TAB_ID=… <engine>`
    // (terminal-tab-spawn.ts), and hooks are the engine's subprocesses, so the
    // vars arrive here by inheritance. cwd alone can't tell tabs apart — every
    // tab of a task shares the worktree. Env taskId also beats the cwd map
    // (exact identity vs longest-prefix guess) but yields to an explicit flag.
    const envTaskId = process.env.KOBE_TASK_ID
    const envTabId = process.env.KOBE_TAB_ID
    // Payload → neutral detail is the engine adapter's job (it owns the
    // vendor's payload vocabulary, e.g. Claude's `error_type` classes). The
    // installed hook command carries no vendor id, so ask each adapter with
    // wired hooks (only Claude today) and take the first answer.
    let detail: EngineActivityDetail | undefined
    for (const adapter of activityHookAdapters()) {
      detail = adapter.activityDetailFromPayload(verb, payload)
      if (detail) break
    }

    const client = await connectIfRunning() // NON-spawning by contract
    if (!client) return
    try {
      const effectiveTaskId = taskId ?? envTaskId
      await client.request("engine.reportEvent", {
        ...(effectiveTaskId ? { taskId: effectiveTaskId } : { cwd }),
        kind: verb,
        ...(envTabId ? { tabId: envTabId } : {}),
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
 * Default-ON global hook install (KOB). Called once per kobe launch. Three
 * pieces, all best-effort and idempotent (the adapter skips the write when
 * nothing changes):
 *
 *  1. **Activity hooks** — Stop / StopFailure / Notification / Session* into the
 *     user's global `~/.claude/settings.json`, so EVERY Claude session reports
 *     normalized events; the daemon maps each hook's cwd to a task. Always
 *     global (a task's badge must light up wherever its engine runs).
 *  2. **Worktree-watch hook** — a global `PostToolUse` (Bash) observer that
 *     adopts a worktree as a task the MOMENT a `git worktree add` runs in any
 *     session, so it shows in the sidebar WITHOUT a running engine (the
 *     creation-time complement to the `session-start` auto-adopt below). This is
 *     a pure OBSERVER fired AFTER the tool, NOT a provider hook — see (3) for why
 *     that distinction is load-bearing.
 *  3. **WorktreeCreate cleanup** — earlier kobe (0.7.4–0.7.9) installed a global
 *     `WorktreeCreate` hook for external-worktree sync. That was WRONG:
 *     `WorktreeCreate` is a VCS *provider* hook — its mere presence makes Claude
 *     Code delegate worktree creation to it and skip the native git path, so
 *     kobe's observer hook (which returns no path) BROKE `claude --worktree` /
 *     `EnterWorktree` in every repo. We now remove any such hook we ever wrote.
 *     Creation-time sync is reborn via the `PostToolUse` hook in (2) — safe
 *     because `PostToolUse` only observes, it never provides; plus the daemon's
 *     `session-start` auto-adopt (`daemon/cwd-task.ts` `findAdoptableWorktree`)
 *     still catches worktrees first entered by an engine session.
 *
 * Writing the user's global settings.json is intentionally invasive but
 * acceptable for now (current users are developers).
 */
export async function ensureGlobalKobeHooks(): Promise<void> {
  try {
    // 1. Activity hooks + the creation-time worktree-watch hook — both global,
    //    each written into the ENGINE's own settings file (Claude's
    //    ~/.claude/settings.json, Codex's ~/.codex/hooks.json) so every session
    //    of that engine reports.
    for (const a of activityHookAdapters()) {
      const enginePath = a.globalSettingsPath()
      if (!enginePath) continue
      await a.installActivityHooks(enginePath)
      // PostToolUse(Bash) observer: a `git worktree add` in ANY session adopts
      // the new worktree as a task immediately (no session needed). Pure
      // observer — unlike the removed WorktreeCreate provider hook, it can't
      // break `claude --worktree`.
      await a.installWorktreeWatchHook(enginePath)
    }
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
