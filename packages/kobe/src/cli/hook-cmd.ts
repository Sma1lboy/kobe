import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { connectIfRunning } from "@sma1lboy/kobe-daemon/client/daemon-process"
import { createEngineHookAdapter } from "../engine/hook-adapter.ts"
import type { EngineActivityDetail } from "../engine/hook-events.ts"
import { isEngineActivityKind } from "../engine/hook-events.ts"
import { getPersistedString, setPersistedString } from "../state/repos.ts"
import { ALL_VENDORS } from "../types/vendor.ts"

const STDIN_READ_TIMEOUT_MS = 500

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

const WORKTREE_CREATED_VERB = "worktree-created"

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function tokenizeCommand(command: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: canonical regex-exec loop
  while ((m = re.exec(command)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "")
  return out
}

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
        j += valueFlags.has(t) ? 2 : 1
        continue
      }
      return t
    }
  }
  return undefined
}

export function parseWorktreeRemovePath(command: string): string | undefined {
  const tokens = tokenizeCommand(command)
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i] !== "worktree" || tokens[i + 1] !== "remove") continue
    let j = i + 2
    while (j < tokens.length) {
      const t = tokens[j]
      if (t === "&&" || t === "||" || t === ";" || t === "|" || t === ">" || t === ">>") break
      if (t.startsWith("-")) {
        j += 1
        continue
      }
      return t
    }
  }
  return undefined
}

async function runWorktreeCreatedHook(): Promise<void> {
  const payload = await readStdinPayload()
  const toolInput = isPlainObject(payload.tool_input) ? payload.tool_input : {}
  const command = typeof toolInput.command === "string" ? toolInput.command : ""
  if (!command.includes("worktree")) return
  const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd()
  const addPath = parseWorktreeAddPath(command)
  const removePath = addPath ? undefined : parseWorktreeRemovePath(command)
  if (!addPath && !removePath) return
  const client = await connectIfRunning()
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
  if (verb === "setup") {
    await runHookSetup(rest)
    return
  }
  if (verb === WORKTREE_CREATED_VERB) {
    try {
      await runWorktreeCreatedHook()
    } catch {}
    return
  }
  try {
    if (!verb || !isEngineActivityKind(verb)) return

    const payload = await readStdinPayload()
    const taskId = flagValue(rest, "--task-id")
    const cwd = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd()
    let detail: EngineActivityDetail | undefined
    for (const adapter of activityHookAdapters()) {
      detail = adapter.activityDetailFromPayload(verb, payload)
      if (detail) break
    }

    const client = await connectIfRunning()
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
  } catch {}
}

const SYNC_SETTING_KEY = "externalWorktreeSync"

function worktreeSyncAdapters() {
  return ALL_VENDORS.map((v) => createEngineHookAdapter(v)).filter((a) => a.supportsWorktreeSync())
}

function activityHookAdapters() {
  return ALL_VENDORS.map((v) => createEngineHookAdapter(v)).filter((a) => a.supportsHooks())
}

function globalSettingsPath(): string {
  return join(homedir(), ".claude", "settings.json")
}

function persistedSyncPath(stored: string | undefined): string | undefined {
  if (!stored || stored === "off") return undefined
  if (stored === "global") return globalSettingsPath()
  if (stored.startsWith("repo:")) return join(resolve(stored.slice(5)), ".claude", "settings.json")
  return stored
}

export async function ensureGlobalKobeHooks(): Promise<void> {
  try {
    for (const a of activityHookAdapters()) {
      const enginePath = a.globalSettingsPath()
      if (!enginePath) continue
      await a.installActivityHooks(enginePath)
      await a.installWorktreeWatchHook(enginePath)
    }
    await cleanupWorktreeSyncHook()
  } catch {}
}

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
