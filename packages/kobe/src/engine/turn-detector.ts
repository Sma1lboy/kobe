import { readFile } from "node:fs/promises"
import * as claudeHistory from "@/engine/claude-code-local/history"
import * as codexHistory from "@/engine/codex-local/history"
import type { VendorId } from "@/types/vendor"
import { engineEntry } from "./registry.ts"

export type ChatTabTurnState = "idle" | "running" | "done" | "error" | "unknown"

export interface TurnCompletionMarker {
  readonly id: string
  readonly timestampMs: number
  readonly source: VendorId
}

export abstract class EngineTurnDetector {
  abstract readonly vendor: VendorId

  supportsCompletionMarkers(): boolean {
    return true
  }

  abstract latestCompletion(worktree: string): Promise<TurnCompletionMarker | null>
}

export function createEngineTurnDetector(vendor: VendorId): EngineTurnDetector {
  return engineEntry(vendor).createTurnDetector()
}

export interface ClaudeTurnDetectorDeps {
  listSessionFiles(worktree: string): Promise<claudeHistory.WorktreeSessionFile[]>
  readFile(path: string): Promise<string>
}

const defaultClaudeDeps: ClaudeTurnDetectorDeps = {
  listSessionFiles: (worktree) => claudeHistory.listSessionFilesForWorktree(worktree),
  readFile: (path) => readFile(path, "utf8"),
}

export class ClaudeTurnDetector extends EngineTurnDetector {
  readonly vendor = "claude" as const

  private cache = new Map<string, { mtimeMs: number; marker: TurnCompletionMarker | null }>()

  constructor(private readonly deps: ClaudeTurnDetectorDeps = defaultClaudeDeps) {
    super()
  }

  async latestCompletion(worktree: string): Promise<TurnCompletionMarker | null> {
    const files = await this.deps.listSessionFiles(worktree)
    let latest: TurnCompletionMarker | null = null
    const next = new Map<string, { mtimeMs: number; marker: TurnCompletionMarker | null }>()
    for (const file of files.slice(0, 4)) {
      const hit = this.cache.get(file.path)
      let marker: TurnCompletionMarker | null
      if (hit && file.mtimeMs > 0 && hit.mtimeMs === file.mtimeMs) {
        marker = hit.marker
      } else {
        const raw = await this.deps.readFile(file.path).catch(() => "")
        marker = latestClaudeCompletionMarkerFromJsonl(raw, file.path, file.mtimeMs)
      }
      next.set(file.path, { mtimeMs: file.mtimeMs, marker })
      if (marker && (!latest || marker.timestampMs > latest.timestampMs)) latest = marker
    }
    this.cache = next
    return latest
  }
}

export interface CodexTurnDetectorDeps {
  findLatestRollout(worktree: string): Promise<{ path: string; mtimeMs: number } | null>
  readFile(path: string): Promise<string>
}

const defaultCodexDeps: CodexTurnDetectorDeps = {
  findLatestRollout: (worktree) => codexHistory.findLatestRolloutForWorktree(worktree),
  readFile: (path) => readFile(path, "utf8"),
}

export class CodexTurnDetector extends EngineTurnDetector {
  readonly vendor = "codex" as const

  private cache: { path: string; mtimeMs: number; marker: TurnCompletionMarker | null } | null = null

  constructor(private readonly deps: CodexTurnDetectorDeps = defaultCodexDeps) {
    super()
  }

  async latestCompletion(worktree: string): Promise<TurnCompletionMarker | null> {
    if (!worktree) return null
    const found = await this.deps.findLatestRollout(worktree)
    if (!found) return null
    if (this.cache && this.cache.path === found.path && found.mtimeMs > 0 && this.cache.mtimeMs === found.mtimeMs) {
      return this.cache.marker
    }
    const raw = await this.deps.readFile(found.path).catch(() => "")
    if (!raw) return null
    const marker = latestCodexCompletionMarkerFromJsonl(raw, found.path)
    this.cache = { path: found.path, mtimeMs: found.mtimeMs, marker }
    return marker
  }
}

export class UnknownTurnDetector extends EngineTurnDetector {
  constructor(readonly vendor: VendorId) {
    super()
  }

  override supportsCompletionMarkers(): boolean {
    return false
  }

  async latestCompletion(): Promise<TurnCompletionMarker | null> {
    return null
  }
}

export function latestClaudeCompletionMarkerFromJsonl(
  raw: string,
  sourceId = "claude",
  fallbackMtimeMs = 0,
): TurnCompletionMarker | null {
  let latest: TurnCompletionMarker | null = null
  let lineNo = 0
  for (const line of raw.split("\n")) {
    lineNo++
    const record = parseJsonLine(line)
    if (!record) continue
    const inner = isObject(record.message) ? (record.message as Record<string, unknown>) : record
    if (inner.role !== "assistant") continue
    if (!("content" in inner)) continue
    const timestampMs = timestampFromRecord(record, fallbackMtimeMs)
    const marker = {
      id: `claude:${sourceId}:${timestampMs}:${lineNo}`,
      timestampMs,
      source: "claude" as const,
    }
    if (!latest || marker.timestampMs >= latest.timestampMs) latest = marker
  }
  return latest
}

export function latestCodexCompletionMarkerFromJsonl(raw: string, sourceId = "codex"): TurnCompletionMarker | null {
  let latest: TurnCompletionMarker | null = null
  let lineNo = 0
  for (const line of raw.split("\n")) {
    lineNo++
    const record = parseJsonLine(line)
    if (!record || record.type !== "turn.completed") continue
    const timestampMs = timestampFromRecord(record, 0)
    const marker = {
      id: `codex:${sourceId}:${timestampMs}:${lineNo}`,
      timestampMs,
      source: "codex" as const,
    }
    if (!latest || marker.timestampMs >= latest.timestampMs) latest = marker
  }
  return latest
}

function parseJsonLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function timestampFromRecord(record: Record<string, unknown>, fallback: number): number {
  const ts = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
  return Number.isFinite(ts) ? ts : fallback
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
