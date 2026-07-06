import { readdir, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { EngineHistory, Message } from "@/types/engine"
import { isJsonlLineWithinBound, readTextFileBounded } from "../file-bounds"
import { parseRolloutRaw } from "./history-parse"

export { deriveCodexUsageMetrics, parseJsonl } from "./history-parse"

export interface HistoryDeps {
  sessionsDir(): string
  readdir(p: string): Promise<string[]>
  readFile(p: string): Promise<string>
  stat(p: string): Promise<{ mtimeMs: number }>
}

const defaultDeps: HistoryDeps = {
  sessionsDir() {
    return path.join(homedir(), ".codex", "sessions")
  },
  async readdir(p) {
    try {
      return await readdir(p)
    } catch {
      return []
    }
  },
  async readFile(p) {
    return await readTextFileBounded(p)
  },
  stat,
}

const MAX_ROLLOUT_FILES = 5000

let warnedRolloutTruncation = false

export async function listRolloutFiles(deps: HistoryDeps = defaultDeps): Promise<string[]> {
  const root = deps.sessionsDir()
  const years = (await deps.readdir(root)).sort().reverse()
  const out: string[] = []
  for (const y of years) {
    const yp = path.join(root, y)
    const months = (await deps.readdir(yp)).sort().reverse()
    for (const m of months) {
      const mp = path.join(yp, m)
      const days = (await deps.readdir(mp)).sort().reverse()
      for (const d of days) {
        const dp = path.join(mp, d)
        const files = (await deps.readdir(dp)).filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
        files.sort().reverse()
        for (const f of files) {
          out.push(path.join(dp, f))
          if (out.length >= MAX_ROLLOUT_FILES) {
            if (!warnedRolloutTruncation) {
              warnedRolloutTruncation = true
              console.warn(
                `[codex history] rollout scan truncated at ${MAX_ROLLOUT_FILES} files; older sessions may be omitted`,
              )
            }
            return out
          }
        }
      }
    }
  }
  return out
}

export async function findRolloutFile(sessionId: string, deps: HistoryDeps = defaultDeps): Promise<string | undefined> {
  if (!sessionId) return undefined
  const want = sessionId.toLowerCase()
  const all = await listRolloutFiles(deps)
  for (const p of all) {
    if (path.basename(p).match(UUID_AT_END)?.[1]?.toLowerCase() === want) return p
  }
  return undefined
}

const UUID_AT_END = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export function rolloutCwd(raw: string): string {
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!isJsonlLineWithinBound(trimmed)) return ""
    try {
      const rec = JSON.parse(trimmed) as { type?: string; payload?: { cwd?: string } }
      if (rec.type === "session_meta") return rec.payload?.cwd ?? ""
    } catch {}
    return ""
  }
  return ""
}

const rolloutCwdCaches = new WeakMap<HistoryDeps, Map<string, string>>()

async function rolloutCwdForFile(file: string, deps: HistoryDeps): Promise<string | null> {
  let cache = rolloutCwdCaches.get(deps)
  if (!cache) {
    cache = new Map()
    rolloutCwdCaches.set(deps, cache)
  }
  const hit = cache.get(file)
  if (hit !== undefined) return hit
  let raw: string
  try {
    raw = await deps.readFile(file)
  } catch {
    return null
  }
  const cwd = rolloutCwd(raw)
  if (cwd) cache.set(file, cwd)
  return cwd
}

const MAX_WORKTREE_SCAN = 200

export async function listSessionIdsForWorktree(worktree: string, deps: HistoryDeps = defaultDeps): Promise<string[]> {
  if (!worktree) return []
  const files = await listRolloutFiles(deps)
  const matches: string[] = []
  let scanned = 0
  for (const file of files) {
    if (scanned >= MAX_WORKTREE_SCAN) break
    scanned++
    if ((await rolloutCwdForFile(file, deps)) !== worktree) continue
    const id = path.basename(file).match(UUID_AT_END)?.[1]
    if (id) matches.push(id)
  }
  return matches.reverse()
}

const MAX_MTIME_SCAN = 12

export async function findLatestRolloutForWorktree(
  worktree: string,
  deps: HistoryDeps = defaultDeps,
): Promise<{ path: string; mtimeMs: number } | null> {
  if (!worktree) return null
  const files = await listRolloutFiles(deps)
  let scanned = 0
  for (const file of files) {
    if (scanned >= MAX_MTIME_SCAN) break
    scanned++
    if ((await rolloutCwdForFile(file, deps)) !== worktree) continue
    try {
      return { path: file, mtimeMs: (await deps.stat(file)).mtimeMs }
    } catch {}
  }
  return null
}

export async function latestTranscriptMtimeForWorktree(
  worktree: string,
  deps: HistoryDeps = defaultDeps,
): Promise<number> {
  return (await findLatestRolloutForWorktree(worktree, deps))?.mtimeMs ?? 0
}

export async function readHistory(sessionId: string, deps: HistoryDeps = defaultDeps): Promise<Message[]> {
  return (await readHistoryWithMetrics(sessionId, deps)).messages as Message[]
}

export async function readHistoryWithMetrics(
  sessionId: string,
  deps: HistoryDeps = defaultDeps,
): Promise<EngineHistory> {
  const file = await findRolloutFile(sessionId, deps)
  if (!file) return { messages: [] }
  let raw: string
  try {
    raw = await deps.readFile(file)
  } catch {
    return { messages: [] }
  }
  return parseRolloutRaw(file, raw, sessionId)
}

export async function deleteHistory(sessionId: string, deps: HistoryDeps = defaultDeps): Promise<void> {
  const file = await findRolloutFile(sessionId, deps)
  if (!file) return
  try {
    await unlink(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return
    throw err
  }
}
