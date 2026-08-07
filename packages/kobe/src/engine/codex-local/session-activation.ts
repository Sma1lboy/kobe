/**
 * Immediate Codex `/resume` observation.
 *
 * Codex's SessionStart hook is deliberately deferred until the next turn, so
 * it cannot tell a host UI which conversation the native resume picker just
 * activated. Codex does, however, persist PID-scoped structured evidence while
 * resume is in flight: a `thread/resume` span appears first, followed by either
 * a rollout-recorder path or the selected `thread.id`. This adapter normalizes
 * both phases; callers never see Codex's SQLite schema or log wording.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { foregroundEngine } from "../foreground.ts"
import { rolloutSessionId } from "./history.ts"

const RESUME_TARGET = "codex_rollout::recorder"
const RESUME_PREFIX = "Resuming rollout from "
const RESUME_SPAN_PREFIX = "app_server.request{"
const RESUME_SPAN_NAME = 'otel.name="thread/resume"'
const RESUME_WITH_HISTORY = ":resume_thread_with_history:"
const THREAD_ID = /\bthread\.id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i

interface CodexResumeLogRow {
  readonly id: number
  readonly ts: number
  readonly ts_nanos: number
  readonly feedback_log_body: string | null
}

export type EngineSessionActivation =
  | {
      readonly phase: "pending"
      readonly source: "resume"
      readonly observedAt: number
    }
  | {
      readonly phase: "selected"
      readonly sessionId: string
      readonly transcriptPath?: string
      readonly source: "resume"
      readonly observedAt: number
    }

export interface CodexSessionActivationInput {
  /** Root child owned by the tab's PTY sidecar. */
  readonly rootPid: number
  /** Ignore resume records at or before the current EngineRun update. */
  readonly afterMs: number
}

export interface CodexSessionActivationDeps {
  readonly findEnginePid: (rootPid: number) => Promise<{ vendor: string; pid: number } | null>
  readonly latestResume: (pid: number, afterMs: number) => CodexResumeLogRow | null | Promise<CodexResumeLogRow | null>
}

function defaultCodexHome(): string {
  return process.env.CODEX_HOME?.trim() || join(homedir(), ".codex")
}

function observedAtMs(row: Pick<CodexResumeLogRow, "ts" | "ts_nanos">): number {
  return row.ts * 1000 + Math.floor(row.ts_nanos / 1_000_000)
}

export function parseCodexResumeLog(row: CodexResumeLogRow): EngineSessionActivation | null {
  const body = row.feedback_log_body
  if (!body) return null

  if (body.startsWith(RESUME_PREFIX)) {
    const quoted = /^Resuming rollout from "([^"]+\.jsonl)"$/.exec(body)
    if (!quoted?.[1]) return null
    const sessionId = rolloutSessionId(quoted[1])
    if (!sessionId) return null
    return {
      phase: "selected",
      sessionId,
      transcriptPath: quoted[1],
      source: "resume",
      observedAt: observedAtMs(row),
    }
  }

  // Newer Codex builds can reconstruct a selected thread through app-server
  // state without emitting the rollout-recorder line. Restrict this fallback
  // to the actual resume span so transcript text mentioning these tokens can
  // never be mistaken for identity evidence.
  if (!body.startsWith(RESUME_SPAN_PREFIX) || !body.includes(RESUME_SPAN_NAME) || !body.includes(RESUME_WITH_HISTORY)) {
    return null
  }
  const sessionId = THREAD_ID.exec(body)?.[1]
  return sessionId
    ? {
        phase: "selected",
        sessionId,
        source: "resume",
        observedAt: observedAtMs(row),
      }
    : {
        phase: "pending",
        source: "resume",
        observedAt: observedAtMs(row),
      }
}

async function latestResumeFromSqlite(pid: number, afterMs: number): Promise<CodexResumeLogRow | null> {
  const path = join(defaultCodexHome(), "logs_2.sqlite")
  const { Database } = await import("bun:sqlite")
  let db: InstanceType<typeof Database> | null = null
  try {
    db = new Database(path, { readonly: true, create: false })
    const seconds = Math.floor(afterMs / 1000)
    const nanos = Math.floor(afterMs % 1000) * 1_000_000
    // A lexical range keeps SQLite on the process_uuid index. `LIKE
    // 'pid:N:%'` scanned the user's ~666MB log DB during diagnosis.
    const processLo = `pid:${pid}:`
    const processHi = `pid:${pid};`
    return db
      .query<CodexResumeLogRow, [string, string, string, number, number, number]>(
        `SELECT id, ts, ts_nanos, feedback_log_body
           FROM logs
          WHERE process_uuid >= ?1 AND process_uuid < ?2
            AND thread_id IS NULL
            AND (
              (target = ?3 AND feedback_log_body LIKE 'Resuming rollout from %')
              OR (
                feedback_log_body LIKE 'app_server.request{%'
                AND feedback_log_body LIKE '%otel.name="thread/resume"%'
                AND feedback_log_body LIKE '%:resume_thread_with_history:%'
              )
            )
            AND (ts > ?4 OR (ts = ?5 AND ts_nanos > ?6))
          ORDER BY ts DESC, ts_nanos DESC, id DESC
          LIMIT 1`,
      )
      .get(processLo, processHi, RESUME_TARGET, seconds, seconds, nanos)
  } catch {
    // Internal telemetry is a compatibility signal, never a reason to break
    // the engine. SessionStart remains the authoritative fallback.
    return null
  } finally {
    db?.close()
  }
}

const defaultDeps: CodexSessionActivationDeps = {
  async findEnginePid(rootPid) {
    const engine = await foregroundEngine(rootPid)
    return engine ? { vendor: engine.vendor, pid: engine.pid } : null
  },
  latestResume: latestResumeFromSqlite,
}

export async function observeCodexSessionActivation(
  input: CodexSessionActivationInput,
  deps: CodexSessionActivationDeps = defaultDeps,
): Promise<EngineSessionActivation | null> {
  if (!Number.isInteger(input.rootPid) || input.rootPid <= 0 || !Number.isFinite(input.afterMs)) return null
  const engine = await deps.findEnginePid(input.rootPid)
  if (!engine || engine.vendor !== "codex") return null
  const row = await deps.latestResume(engine.pid, Math.max(0, input.afterMs))
  return row ? parseCodexResumeLog(row) : null
}
