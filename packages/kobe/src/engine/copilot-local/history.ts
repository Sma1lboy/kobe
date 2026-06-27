import { readdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { ContentBlock } from "@/types/content"
import type { EngineHistory, EngineUsageSnapshot, Message } from "@/types/engine"
import { isJsonlLineWithinBound, readTextFileBounded } from "../file-bounds"
import { copilotUsageToSnapshot } from "./usage"

export interface CopilotHistoryDeps {
  copilotDir(): string
  readdir(p: string): Promise<string[]>
  readFile(p: string): Promise<string>
  stat(p: string): Promise<{ mtimeMs: number }>
  rm(p: string): Promise<void>
}

const defaultDeps: CopilotHistoryDeps = {
  copilotDir() {
    const override = process.env.COPILOT_HOME?.trim()
    if (override) return override
    return path.join(homedir(), ".copilot")
  },
  async readdir(p) {
    try {
      return await readdir(p)
    } catch {
      return []
    }
  },
  async readFile(p) {
    // Size-bounded: an oversize/corrupt events.jsonl degrades to "" rather
    // than slurping a multi-GB file into memory.
    return await readTextFileBounded(p)
  },
  stat,
  async rm(p) {
    await rm(p, { recursive: true, force: true })
  },
}

export async function listSessionDirs(deps: CopilotHistoryDeps = defaultDeps): Promise<string[]> {
  const root = path.join(deps.copilotDir(), "session-state")
  const names = await deps.readdir(root)
  return names.map((name) => path.join(root, name))
}

/**
 * Session ids of Copilot conversations rooted at `worktree`, oldest-first.
 *
 * The monitor's auto-title dispatch (and any future per-vendor history
 * walk) calls this the same way it calls Claude's
 * `listSessionFilesForWorktree` / Codex's `listSessionIdsForWorktree`.
 * Copilot stores each session as a directory under
 * `~/.copilot/session-state/<id>/` with a `workspace.yaml` recording the
 * `cwd`; we match that against the worktree and order by `updatedAt`
 * (newest workspace timestamp last so the origin conversation comes
 * first, matching the other readers' oldest-first contract).
 */
export async function listSessionIdsForWorktree(
  worktree: string,
  deps: CopilotHistoryDeps = defaultDeps,
): Promise<string[]> {
  const matches: { id: string; updatedAt: string }[] = []
  for (const dir of await listSessionDirs(deps)) {
    const workspace = await readWorkspace(dir, deps)
    if (workspace.cwd !== worktree) continue
    matches.push({ id: workspace.id ?? path.basename(dir), updatedAt: workspace.updatedAt ?? "" })
  }
  return matches.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).map((m) => m.id)
}

/**
 * Newest `events.jsonl` mtime (epoch ms) across the Copilot sessions
 * rooted at `worktree`, or 0 when none match. The Ops pane polls this to
 * detect new Copilot conversation output without parsing the tmux pane
 * (KOB-254). Each session is a dir with a `workspace.yaml` (for the cwd
 * match) and a growing `events.jsonl` (the transcript we stat).
 */
export async function latestTranscriptMtimeForWorktree(
  worktree: string,
  deps: CopilotHistoryDeps = defaultDeps,
): Promise<number> {
  if (!worktree) return 0
  let newest = 0
  for (const dir of await listSessionDirs(deps)) {
    const workspace = await readWorkspace(dir, deps)
    if (workspace.cwd !== worktree) continue
    try {
      const { mtimeMs } = await deps.stat(path.join(dir, "events.jsonl"))
      if (mtimeMs > newest) newest = mtimeMs
    } catch {
      // session dir without an events.jsonl yet — skip
    }
  }
  return newest
}

export async function readHistoryWithMetrics(
  sessionId: string,
  deps: CopilotHistoryDeps = defaultDeps,
): Promise<EngineHistory> {
  const dir = await findSessionDir(sessionId, deps)
  if (!dir) return { messages: [] }
  const raw = await deps.readFile(path.join(dir, "events.jsonl")).catch(() => "")
  const parsed = parseEvents(raw, sessionId)
  return { messages: parsed.messages, ...(parsed.usageMetrics ? { usageMetrics: parsed.usageMetrics } : {}) }
}

export async function readHistory(sessionId: string, deps: CopilotHistoryDeps = defaultDeps): Promise<Message[]> {
  return (await readHistoryWithMetrics(sessionId, deps)).messages as Message[]
}

export async function deleteHistory(sessionId: string, deps: CopilotHistoryDeps = defaultDeps): Promise<void> {
  const dir = await findSessionDir(sessionId, deps)
  if (!dir) return
  await deps.rm(dir)
}

export async function findSessionDir(
  sessionId: string,
  deps: CopilotHistoryDeps = defaultDeps,
): Promise<string | undefined> {
  for (const dir of await listSessionDirs(deps)) {
    if (path.basename(dir) === sessionId) return dir
    const workspace = await readWorkspace(dir, deps)
    if (workspace.id === sessionId || workspace.name?.toLowerCase() === sessionId.toLowerCase()) return dir
  }
  return undefined
}

export interface CopilotWorkspaceMeta {
  readonly id?: string
  readonly cwd?: string
  readonly name?: string
  readonly updatedAt?: string
  readonly createdAt?: string
}

export async function readWorkspace(
  dir: string,
  deps: CopilotHistoryDeps = defaultDeps,
): Promise<CopilotWorkspaceMeta> {
  const raw = await deps.readFile(path.join(dir, "workspace.yaml")).catch(() => "")
  return parseWorkspaceYaml(raw)
}

export function parseWorkspaceYaml(raw: string): CopilotWorkspaceMeta {
  const out: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z_]+):\s*(.*)$/)
    if (!match) continue
    const key = match[1]
    let value = match[2] ?? ""
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"')
    out[key] = value
  }
  return {
    id: out.id,
    cwd: out.cwd,
    name: out.name,
    updatedAt: out.updated_at,
    createdAt: out.created_at,
  }
}

export function parseEvents(
  raw: string,
  fallbackSessionId: string,
): { messages: Message[]; usageMetrics?: EngineUsageSnapshot; firstUserMessage?: string | null } {
  const messages: Message[] = []
  const toolNameById = new Map<string, string>()
  let sessionId = fallbackSessionId
  let usageMetrics: EngineUsageSnapshot | undefined
  let firstUserMessage: string | null = null

  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (!isJsonlLineWithinBound(trimmed)) continue
    let record: unknown
    try {
      record = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!isObject(record) || typeof record.type !== "string") continue
    const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString()
    const data = isObject(record.data) ? record.data : {}

    if (record.type === "session.start") {
      const sid = typeof data.sessionId === "string" ? data.sessionId : undefined
      if (sid) sessionId = sid
      continue
    }

    if (record.type === "user.message") {
      const text = typeof data.content === "string" ? data.content : ""
      if (!text) continue
      // Force-copy: in JSC (Bun) `.slice` shares the parent string's backing
      // buffer, so a 200-char preview would otherwise pin the full message
      // text for as long as a caller retains the preview.
      if (!firstUserMessage) firstUserMessage = Buffer.from(text.slice(0, PREVIEW_CHAR_CAP), "utf8").toString("utf8")
      messages.push({ role: "user", blocks: [{ type: "text", text }], timestamp, sessionId })
      continue
    }

    if (record.type === "assistant.message") {
      const blocks: ContentBlock[] = []
      const text = typeof data.content === "string" ? data.content : ""
      if (text) blocks.push({ type: "text", text })
      const toolRequests = Array.isArray(data.toolRequests) ? data.toolRequests : []
      for (const req of toolRequests) {
        if (!isObject(req)) continue
        const callId =
          typeof req.id === "string" ? req.id : typeof req.toolCallId === "string" ? req.toolCallId : "tool"
        const name = typeof req.name === "string" ? req.name : typeof req.toolName === "string" ? req.toolName : "tool"
        blocks.push({ type: "tool_call", callId, name, input: req.arguments ?? {} })
      }
      if (blocks.length > 0) messages.push({ role: "assistant", blocks, timestamp, sessionId })
      continue
    }

    if (record.type === "tool.execution_start") {
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined
      const name = typeof data.toolName === "string" ? data.toolName : "tool"
      if (callId) toolNameById.set(callId, name)
      continue
    }

    if (record.type === "tool.execution_complete") {
      const callId = typeof data.toolCallId === "string" ? data.toolCallId : undefined
      if (!callId) continue
      const name = toolNameById.get(callId) ?? (typeof data.toolName === "string" ? data.toolName : "tool")
      const output = data.result ?? (data.success === false ? { success: false } : undefined)
      messages.push({
        role: "assistant",
        blocks: [{ type: "tool_result", callId, output, isError: data.success === false }],
        timestamp,
        sessionId,
      })
      continue
    }

    if (record.type === "session.shutdown") {
      usageMetrics = copilotUsageToSnapshot(data)
    }
  }

  return { messages, usageMetrics, firstUserMessage }
}

const PREVIEW_CHAR_CAP = 200

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
