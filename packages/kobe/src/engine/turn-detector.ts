/**
 * Engine-owned turn completion detection for tmux ChatTabs.
 *
 * Warp's reliable status model comes from structured response-stream
 * lifecycle events. kobe v0.6 delegates engines to interactive CLIs inside
 * tmux, so we cannot observe the live stream directly. The next-best
 * contract is engine-owned transcript markers: each vendor adapter knows
 * which persisted record means "a turn completed"; UI code only asks this
 * abstraction and combines it with pane quiescence.
 */

import { readFile } from "node:fs/promises"
import * as claudeHistory from "@/engine/claude-code-local/history"
import * as codexHistory from "@/engine/codex-local/history"
import type { VendorId } from "@/types/vendor"
import { engineEntry } from "./registry.ts"

export type ChatTabTurnState = "idle" | "running" | "done" | "error" | "unknown"

export interface TurnCompletionMarker {
  readonly id: string
  readonly timestampMs: number
  /** Which engine's transcript produced the marker (built-ins only today). */
  readonly source: VendorId
}

export abstract class EngineTurnDetector {
  abstract readonly vendor: VendorId

  /** Whether this detector can emit completion markers for its vendor. */
  supportsCompletionMarkers(): boolean {
    return true
  }

  /** Newest persisted completion marker for `worktree`, or null when absent. */
  abstract latestCompletion(worktree: string): Promise<TurnCompletionMarker | null>
}

/**
 * Resolve the turn detector for a vendor — a thin delegate to the engine
 * registry, which owns the per-vendor choice (one entry per engine; see
 * `registry.ts`). Kept exported here so call sites (`tui/ops/host.tsx`)
 * keep their import. NB: registry.ts imports the detector classes below,
 * so this pair is an intentional import cycle (same pattern as
 * `hook-adapter.ts`) — both sides only dereference the other's bindings
 * inside function bodies, never at module top-level, which keeps the cycle
 * safe under ESM evaluation order.
 */
export function createEngineTurnDetector(vendor: VendorId): EngineTurnDetector {
  return engineEntry(vendor).createTurnDetector()
}

export class ClaudeTurnDetector extends EngineTurnDetector {
  readonly vendor = "claude" as const

  async latestCompletion(worktree: string): Promise<TurnCompletionMarker | null> {
    const files = await claudeHistory.listSessionFilesForWorktree(worktree)
    let latest: TurnCompletionMarker | null = null
    for (const file of files.slice(0, 4)) {
      const raw = await readFile(file.path, "utf8").catch(() => "")
      const marker = latestClaudeCompletionMarkerFromJsonl(raw, file.path, file.mtimeMs)
      if (marker && (!latest || marker.timestampMs > latest.timestampMs)) latest = marker
    }
    return latest
  }
}

export class CodexTurnDetector extends EngineTurnDetector {
  readonly vendor = "codex" as const

  async latestCompletion(worktree: string): Promise<TurnCompletionMarker | null> {
    if (!worktree) return null
    const files = await codexHistory.listRolloutFiles()
    let scanned = 0
    for (const file of files) {
      if (scanned >= 12) break
      scanned++
      const raw = await readFile(file, "utf8").catch(() => "")
      if (!raw || codexHistory.rolloutCwd(raw) !== worktree) continue
      return latestCodexCompletionMarkerFromJsonl(raw, file)
    }
    return null
  }
}

/** Detector for vendors without transcript completion markers (copilot, custom). */
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
