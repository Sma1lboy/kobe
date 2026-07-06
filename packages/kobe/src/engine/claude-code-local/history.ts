import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readdir, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Message } from "@/types/engine"
import { isJsonlLineWithinBound, readTextFileBounded } from "../file-bounds"
import { isObject, parseSessionRaw } from "./history-parse"

export { parseJsonl } from "./history-parse"

export interface HistoryDeps {
  projectsDir(): string
  readdir(p: string): Promise<string[]>
  readFile(p: string): Promise<string>
  pathExists(p: string): Promise<boolean>
}

const defaultDeps: HistoryDeps = {
  projectsDir() {
    return path.join(homedir(), ".claude", "projects")
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
  async pathExists(p) {
    try {
      await readdir(p)
      return true
    } catch {
      return false
    }
  },
}

export function encodeCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-")
}

export interface WorktreeSessionFile {
  readonly sessionId: string
  readonly path: string
  readonly mtimeMs: number
}

export async function listSessionFilesForWorktree(worktree: string): Promise<WorktreeSessionFile[]> {
  if (!worktree) return []
  const dir = path.join(homedir(), ".claude", "projects", encodeCwd(worktree))
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }
  const out: WorktreeSessionFile[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue
    const full = path.join(dir, entry)
    let mtimeMs = 0
    try {
      mtimeMs = (await stat(full)).mtimeMs
    } catch {}
    out.push({ sessionId: entry.slice(0, -".jsonl".length), path: full, mtimeMs })
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

export async function latestTranscriptMtimeForWorktree(worktree: string): Promise<number> {
  const files = await listSessionFilesForWorktree(worktree)
  return files[0]?.mtimeMs ?? 0
}

export async function readHistory(sessionId: string, deps: HistoryDeps = defaultDeps): Promise<Message[]> {
  const root = deps.projectsDir()
  const projectDirs = await deps.readdir(root)

  for (const dir of projectDirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`)
    let raw: string
    try {
      raw = await deps.readFile(candidate)
    } catch {
      continue
    }
    return parseSessionRaw(candidate, raw, sessionId)
  }
  return []
}

export async function deleteHistory(sessionId: string, deps: HistoryDeps = defaultDeps): Promise<void> {
  const root = deps.projectsDir()
  const projectDirs = await deps.readdir(root)
  for (const dir of projectDirs) {
    const candidate = path.join(root, dir, `${sessionId}.jsonl`)
    try {
      await unlink(candidate)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue
      throw err
    }
  }
}

export async function appendInterruptedUserPrompt(
  sessionId: string,
  cwd: string,
  prompt: string,
  deps: HistoryDeps = defaultDeps,
): Promise<void> {
  if (!prompt || prompt.trim().length === 0) return

  const projectDir = path.join(deps.projectsDir(), encodeCwd(cwd))
  const filePath = path.join(projectDir, `${sessionId}.jsonl`)

  let lines: string[] = []
  try {
    const raw = await readTextFileBounded(filePath)
    lines = raw.split("\n").filter((l) => l.length > 0)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    await mkdir(projectDir, { recursive: true })
  }

  let lastConvRecord: Record<string, unknown> | null = null
  let lastConvRole: "user" | "assistant" | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string
    if (!isJsonlLineWithinBound(line)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(parsed)) continue
    const inner = isObject(parsed.message) ? (parsed.message as Record<string, unknown>) : parsed
    const role = inner.role
    if (role === "user" || role === "assistant") {
      lastConvRecord = parsed
      lastConvRole = role
      break
    }
  }

  const now = new Date().toISOString()

  let content = prompt
  let parentUuid = lastConvRecord && typeof lastConvRecord.uuid === "string" ? (lastConvRecord.uuid as string) : null

  if (lastConvRole === "user" && lastConvRecord) {
    const inner = isObject(lastConvRecord.message)
      ? (lastConvRecord.message as Record<string, unknown>)
      : lastConvRecord
    const existing = typeof inner.content === "string" ? inner.content : ""
    if (existing === prompt || existing.endsWith(`\n\n${prompt}`)) return
    content = existing.length > 0 ? `${existing}\n\n${prompt}` : prompt
    parentUuid = typeof lastConvRecord.parentUuid === "string" ? (lastConvRecord.parentUuid as string) : null
  }

  const record = {
    type: "user",
    message: { role: "user", content },
    uuid: randomUUID(),
    parentUuid,
    sessionId,
    cwd,
    timestamp: now,
    isSidechain: false,
    userType: "external",
    version: "1.0.0",
  }
  await appendFile(filePath, `${JSON.stringify(record)}\n`)
}
