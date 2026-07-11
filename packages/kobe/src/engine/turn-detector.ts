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
  /**
   * Opaque identity for "this exact completion". Callers (the Ops pane's
   * turn poller) store it long-lived as a baseline across polls.
   *
   * MEMORY INVARIANT: the id must NEVER be (or contain) a substring of the
   * transcript file contents. In JSC (Bun) a `.slice`/`.match` of a string
   * shares the parent's backing buffer, so a long-lived id sliced out of a
   * whole-file JSONL read would pin the entire multi-MB transcript in
   * memory between polls. The builders below construct ids from template
   * literals over numbers + the file PATH (an independent small string) —
   * keep it that way, or force-copy with `Buffer.from(s).toString()`.
   */
  readonly id: string
  readonly timestampMs: number
  /** Which engine's transcript produced the marker (built-ins only today). */
  readonly source: VendorId
}

/**
 * The two fs-derived facts a single transcript-dir scan yields: the newest
 * completion marker AND the newest transcript mtime. The daemon collector
 * wants both per probe, and finding the completion already walks the dir
 * and stats its files — so one scan surfaces both instead of two callers
 * each doing their own readdir (the perf win). `mtimeMs` is `0` when the
 * worktree has no transcript yet (or the detector has no store to read).
 */
export interface TranscriptScan {
  readonly marker: TurnCompletionMarker | null
  readonly mtimeMs: number
}

export abstract class EngineTurnDetector {
  abstract readonly vendor: VendorId

  /** Whether this detector can emit completion markers for its vendor. */
  supportsCompletionMarkers(): boolean {
    return true
  }

  /**
   * Newest completion marker AND newest transcript mtime for `worktree`
   * from ONE directory scan. Callers that want both (the daemon's activity
   * collector) use this so the transcript dir is listed once, not twice.
   */
  abstract latestActivity(worktree: string): Promise<TranscriptScan>

  /** Newest persisted completion marker for `worktree`, or null when absent. */
  async latestCompletion(worktree: string): Promise<TurnCompletionMarker | null> {
    return (await this.latestActivity(worktree)).marker
  }
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

/** Injectable IO surface for {@link ClaudeTurnDetector} (unit tests). */
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

  /**
   * Marker memo keyed by transcript path, valid while the file's mtime is
   * unchanged. The Ops pane calls `latestCompletion` from a 1.5s poll, and
   * before this gate every call re-read + re-parsed up to 4 WHOLE session
   * JSONLs (multi-MB for a day-long session) even though nothing had been
   * appended — the mtime the lister already stat()s is enough to prove the
   * parse would produce the identical marker (it's a pure function of the
   * file content + path + mtime). Pruned to the files of the latest scan,
   * so it never holds more than the 4 entries per detector; the cached
   * marker ids obey the memory invariant above (numbers + path only).
   */
  private cache = new Map<string, { mtimeMs: number; marker: TurnCompletionMarker | null }>()

  constructor(private readonly deps: ClaudeTurnDetectorDeps = defaultClaudeDeps) {
    super()
  }

  async latestActivity(worktree: string): Promise<TranscriptScan> {
    const files = await this.deps.listSessionFiles(worktree)
    // `listSessionFiles` sorts newest-first, so `files[0]` is the newest
    // transcript overall — the same value `latestTranscriptMtimeForWorktree`
    // returns. Surfacing it here lets the daemon collector skip its own
    // second directory scan for the mtime.
    const mtimeMs = files[0]?.mtimeMs ?? 0
    let latest: TurnCompletionMarker | null = null
    const next = new Map<string, { mtimeMs: number; marker: TurnCompletionMarker | null }>()
    for (const file of files.slice(0, 4)) {
      const hit = this.cache.get(file.path)
      let marker: TurnCompletionMarker | null
      // mtime 0 means the lister's stat failed — never trust it as a key.
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
    return { marker: latest, mtimeMs }
  }
}

/** Injectable IO surface for {@link CodexTurnDetector} (unit tests). */
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

  /**
   * Same mtime gate as {@link ClaudeTurnDetector}: the rollout's
   * cwd-matching is already cached inside `findLatestRolloutForWorktree`
   * (a rollout's `session_meta` first line never changes), and this memo
   * skips the whole-file re-read + re-parse when the matched rollout's
   * mtime hasn't moved since the last poll. One entry — only the newest
   * matching rollout is ever consulted.
   */
  private cache: { path: string; mtimeMs: number; marker: TurnCompletionMarker | null } | null = null

  constructor(private readonly deps: CodexTurnDetectorDeps = defaultCodexDeps) {
    super()
  }

  async latestActivity(worktree: string): Promise<TranscriptScan> {
    if (!worktree) return { marker: null, mtimeMs: 0 }
    const found = await this.deps.findLatestRollout(worktree)
    if (!found) return { marker: null, mtimeMs: 0 }
    // `found.mtimeMs` is the newest matching rollout's mtime — identical to
    // what `latestTranscriptMtimeForWorktree` returns — so surface it even
    // when the marker parse below yields null (no `turn.completed` yet).
    if (this.cache && this.cache.path === found.path && found.mtimeMs > 0 && this.cache.mtimeMs === found.mtimeMs) {
      return { marker: this.cache.marker, mtimeMs: found.mtimeMs }
    }
    const raw = await this.deps.readFile(found.path).catch(() => "")
    if (!raw) return { marker: null, mtimeMs: found.mtimeMs }
    const marker = latestCodexCompletionMarkerFromJsonl(raw, found.path)
    this.cache = { path: found.path, mtimeMs: found.mtimeMs, marker }
    return { marker, mtimeMs: found.mtimeMs }
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

  // No transcript store this detector can read — no marker, no mtime. The
  // daemon collector falls back to the vendor's own `latestTranscriptMtime`
  // (e.g. copilot's) when `supportsCompletionMarkers()` is false.
  async latestActivity(): Promise<TranscriptScan> {
    return { marker: null, mtimeMs: 0 }
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

/**
 * Rollout `event_msg` payload types that mean "this turn is done". Codex's
 * real on-disk rollout (codex-cli) never writes a top-level `turn.completed`
 * record — that shape is the `codex exec --json` STREAM event. A rollout wraps
 * each agent event as `{ type: "event_msg", payload: { type: ... } }`, and the
 * completion signal is the flattened EventMsg tag: `task_complete` (v1 wire),
 * `turn_complete` (v2 alias), or `turn_aborted` (interrupted). Sourced from the
 * codex protocol enum (`EventMsg` #[serde(rename_all="snake_case")], with
 * `task_complete`/`turn_complete` aliased on the same variant).
 */
const CODEX_ROLLOUT_DONE_EVENTS = new Set(["task_complete", "turn_complete", "turn_aborted"])

/** True when `record` is a rollout completion marker — either the real
 *  rollout `event_msg` (task_complete / turn_complete / turn_aborted) or the
 *  legacy top-level `turn.completed` from a `codex exec --json` stream dump. */
function isCodexCompletionRecord(record: Record<string, unknown>): boolean {
  if (record.type === "turn.completed") return true
  if (record.type !== "event_msg") return false
  const payload = isObject(record.payload) ? record.payload : undefined
  return typeof payload?.type === "string" && CODEX_ROLLOUT_DONE_EVENTS.has(payload.type)
}

export function latestCodexCompletionMarkerFromJsonl(raw: string, sourceId = "codex"): TurnCompletionMarker | null {
  let latest: TurnCompletionMarker | null = null
  let lineNo = 0
  for (const line of raw.split("\n")) {
    lineNo++
    const record = parseJsonLine(line)
    if (!record || !isCodexCompletionRecord(record)) continue
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
