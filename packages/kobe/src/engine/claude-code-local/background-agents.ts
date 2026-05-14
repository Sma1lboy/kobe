/**
 * Claude Code background-agent index reader.
 *
 * Claude owns the lifecycle and persistence for `claude agents`; kobe only
 * normalizes the session index rows Claude writes under `~/.claude/sessions`.
 */

import { spawn } from "node:child_process"
import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import type { BackgroundAgent, BackgroundAgentStatus, ModelEffortLevel } from "@/types/engine"

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

export interface StartBackgroundAgentOpts {
  readonly binaryPath: string
  readonly cwd: string
  readonly prompt: string
  readonly model?: string
  readonly modelEffort?: ModelEffortLevel
  readonly permissionMode?: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly deps?: BackgroundAgentDeps
}

export async function startBackgroundAgentForCwd(opts: StartBackgroundAgentOpts): Promise<BackgroundAgent | null> {
  const startedAt = Date.now()
  const args = buildBackgroundAgentArgs(opts)
  const { stdout, stderr } = await runClaudeBackgroundAgent({
    binaryPath: opts.binaryPath,
    cwd: opts.cwd,
    args,
    env: opts.env,
    timeoutMs: opts.timeoutMs ?? 30_000,
  })
  const hintedId = parseBackgroundJobId(stdout) ?? parseBackgroundJobId(stderr)
  const agents = await waitForStartedBackgroundAgent(opts.cwd, {
    hintedId,
    startedAt,
    deps: opts.deps,
  })
  return agents[0] ?? null
}

export function buildBackgroundAgentArgs(opts: StartBackgroundAgentOpts): string[] {
  const args = ["--bg", opts.prompt]
  if (opts.model) args.push("--model", opts.model)
  if (opts.modelEffort) args.push("--effort", opts.modelEffort)
  if (opts.permissionMode) args.push("--permission-mode", opts.permissionMode)
  const mcpConfig = process.env.KOBE_MCP_CONFIG
  if (mcpConfig && mcpConfig.length > 0) args.push("--mcp-config", mcpConfig)
  return args
}

function runClaudeBackgroundAgent(opts: {
  readonly binaryPath: string
  readonly cwd: string
  readonly args: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs: number
}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(opts.binaryPath, [...opts.args], {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        proc.kill("SIGTERM")
      } catch {
        // Process may already be gone; reject below still reports timeout.
      }
      reject(new Error("claude --bg timed out before returning"))
    }, opts.timeoutMs)
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    proc.once("error", (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    proc.once("exit", (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const suffix = stderr.trim() || stdout.trim() || (signal ? `signal ${signal}` : `exit code ${code}`)
      reject(new Error(`claude --bg failed: ${suffix}`))
    })
  })
}

async function waitForStartedBackgroundAgent(
  cwd: string,
  opts: {
    readonly hintedId: string | null
    readonly startedAt: number
    readonly deps?: BackgroundAgentDeps
  },
): Promise<BackgroundAgent[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const agents = await listBackgroundAgentsForCwd(cwd, opts.deps)
    const matched = agents.filter((agent) => {
      if (opts.hintedId && (agent.jobId === opts.hintedId || agent.id === opts.hintedId)) return true
      const timestamp = agent.startedAtMs ?? agent.updatedAtMs ?? 0
      return timestamp >= opts.startedAt - 2_000
    })
    if (matched.length > 0) return matched
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return []
}

function parseBackgroundJobId(text: string): string | null {
  const match = text.match(/backgrounded\s+.\s+([a-zA-Z0-9_-]+)/)
  return match?.[1] ?? null
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
