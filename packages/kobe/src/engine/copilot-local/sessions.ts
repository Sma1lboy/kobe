import { homedir } from "node:os"
import path from "node:path"
import type { SessionMeta } from "@/types/engine"
import { type CopilotHistoryDeps, listSessionDirs, parseEvents, readWorkspace } from "./history"

export async function listSessionsForCwd(cwd: string, deps?: CopilotHistoryDeps): Promise<SessionMeta[]> {
  const actualDeps = deps ?? defaultDeps
  const normalized = path.resolve(cwd)
  const out: SessionMeta[] = []
  for (const dir of await listSessionDirs(actualDeps)) {
    const workspace = await readWorkspace(dir, actualDeps)
    if (!workspace.id) continue
    if (!workspace.cwd || !samePath(workspace.cwd, normalized)) continue
    const raw = await actualDeps.readFile(path.join(dir, "events.jsonl")).catch(() => "")
    const parsed = parseEvents(raw, workspace.id)
    const st = await actualDeps.stat(path.join(dir, "events.jsonl")).catch(() => null)
    out.push({
      sessionId: workspace.id,
      mtimeMs: st?.mtimeMs ?? Date.parse(workspace.updatedAt ?? workspace.createdAt ?? "0"),
      firstUserMessage: parsed.firstUserMessage ?? workspace.name ?? null,
      messageCount: parsed.messages.length,
    })
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

const defaultDeps: CopilotHistoryDeps = {
  copilotDir() {
    const override = process.env.COPILOT_HOME?.trim()
    if (override) return override
    return path.join(homedir(), ".copilot")
  },
  async readdir(p) {
    const fs = await import("node:fs/promises")
    try {
      return await fs.readdir(p)
    } catch {
      return []
    }
  },
  async readFile(p) {
    const fs = await import("node:fs/promises")
    return await fs.readFile(p, "utf8")
  },
  async stat(p) {
    const fs = await import("node:fs/promises")
    return await fs.stat(p)
  },
  async rm(p) {
    const fs = await import("node:fs/promises")
    await fs.rm(p, { recursive: true, force: true })
  },
}

function samePath(a: string, b: string): boolean {
  const ar = path.resolve(a)
  const br = path.resolve(b)
  if (process.platform === "win32" || process.platform === "darwin") return ar.toLowerCase() === br.toLowerCase()
  return ar === br
}
