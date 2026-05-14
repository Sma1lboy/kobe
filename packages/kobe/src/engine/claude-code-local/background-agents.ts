/**
 * Claude Code background-agent index reader.
 *
 * Claude owns the lifecycle and persistence for `claude agents`; kobe only
 * normalizes the session index rows Claude writes under `~/.claude/sessions`.
 */

import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { BackgroundAgent, BackgroundAgentStatus } from "@/types/engine"

export interface BackgroundAgentDeps {
  sessionsDir(): string
  readdir(p: string): Promise<string[]>
  readFile(p: string): Promise<string>
}

const defaultDeps: BackgroundAgentDeps = {
  sessionsDir() {
    return path.join(homedir(), ".claude", "sessions")
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
}

export async function listBackgroundAgentsForCwd(
  cwd: string,
  deps: BackgroundAgentDeps = defaultDeps,
): Promise<BackgroundAgent[]> {
  const base = path.resolve(cwd)
  const dir = deps.sessionsDir()
  const names = (await deps.readdir(dir)).filter((name) => name.endsWith(".json"))
  const out: BackgroundAgent[] = []

  for (const name of names) {
    try {
      const parsed = JSON.parse(await deps.readFile(path.join(dir, name))) as unknown
      const agent = normalizeBackgroundAgent(parsed)
      if (agent && isUnderCwd(agent.cwd, base)) out.push(agent)
    } catch {
      // Per-row best effort: one corrupt session index entry should not
      // blank the whole Agent View.
    }
  }

  out.sort((a, b) => (b.updatedAtMs ?? b.startedAtMs ?? 0) - (a.updatedAtMs ?? a.startedAtMs ?? 0))
  return out
}

export function normalizeBackgroundAgent(input: unknown): BackgroundAgent | null {
  if (!isObject(input)) return null
  if (input.kind !== "bg") return null

  const sessionId = asString(input.sessionId)
  const cwd = asString(input.cwd)
  if (!sessionId || !cwd) return null

  const jobId = asString(input.jobId)
  const name = asString(input.name)
  const sourceStatus = asString(input.status)
  return {
    id: jobId ?? sessionId,
    sessionId,
    name,
    status: normalizeStatus(sourceStatus),
    sourceStatus,
    cwd,
    agent: asString(input.agent),
    jobId,
    pid: asNumber(input.pid),
    version: asString(input.version),
    startedAtMs: asNumber(input.startedAt),
    updatedAtMs: asNumber(input.updatedAt),
  }
}

function normalizeStatus(status: string | null): BackgroundAgentStatus {
  const s = (status ?? "").toLowerCase().replace(/[\s_-]+/g, "-")
  if (["running", "working", "active", "in-progress", "busy"].includes(s)) return "running"
  if (["blocked", "needs-input", "awaiting-input", "waiting-for-input"].includes(s)) return "blocked"
  if (["done", "complete", "completed", "success", "succeeded"].includes(s)) return "completed"
  if (["error", "failed", "crashed", "killed"].includes(s)) return "failed"
  if (s === "idle") return "idle"
  return "unknown"
}

function isUnderCwd(candidate: string, base: string): boolean {
  const resolved = path.resolve(candidate)
  if (resolved === base) return true
  const rel = path.relative(base, resolved)
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel)
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
