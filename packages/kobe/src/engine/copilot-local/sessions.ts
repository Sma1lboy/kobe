import { readFile, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { Message, SessionMeta } from "@/types/engine"
import type { CopilotHistoryDeps } from "./history"
import { parseEventsJsonl } from "./history"

const PREVIEW_CHAR_CAP = 200

export async function listSessionsForCwd(cwd: string, deps?: CopilotHistoryDeps): Promise<SessionMeta[]> {
  const actualDeps = deps ?? defaultDeps
  const root = path.join(actualDeps.copilotDir(), "session-state")
  const entries = await actualDeps.readdir(root)
  const out: SessionMeta[] = []
  for (const sessionId of entries) {
    const dir = path.join(root, sessionId)
    const workspace = parseWorkspaceYaml(await actualDeps.readFile(path.join(dir, "workspace.yaml")).catch(() => ""))
    if (!workspace || !samePath(workspace.cwd, cwd)) continue
    const eventsPath = path.join(dir, "events.jsonl")
    const raw = await actualDeps.readFile(eventsPath).catch(() => "")
    const messages = parseEventsJsonl(raw, sessionId)
    const firstUser = messages.find((m) => m.role === "user")
    const st = await stat(eventsPath).catch(() => null)
    const fallbackMtime = Date.parse(workspace.updatedAt ?? workspace.createdAt ?? "") || 0
    out.push({
      sessionId,
      mtimeMs: st?.mtimeMs ?? fallbackMtime,
      firstUserMessage: firstText(firstUser)?.slice(0, PREVIEW_CHAR_CAP) ?? null,
      messageCount: messages.length,
    })
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

function parseWorkspaceYaml(raw: string): { cwd: string; createdAt?: string; updatedAt?: string } | null {
  const values: Record<string, string> = {}
  for (const line of raw.split("\n")) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim())
    if (!m) continue
    values[m[1] as string] = m[2] ?? ""
  }
  if (!values.cwd) return null
  return { cwd: values.cwd, createdAt: values.created_at, updatedAt: values.updated_at }
}

function firstText(message: Message | undefined): string | null {
  const block = message?.blocks.find((b) => b.type === "text")
  return block?.type === "text" ? block.text : null
}

function samePath(a: string, b: string): boolean {
  const ar = path.resolve(a)
  const br = path.resolve(b)
  if (process.platform === "win32" || process.platform === "darwin") return ar.toLowerCase() === br.toLowerCase()
  return ar === br
}

const defaultDeps: CopilotHistoryDeps = {
  copilotDir() {
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
    return await readFile(p, "utf8")
  },
  async unlink() {},
}
