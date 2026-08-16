/**
 * Durable per-turn telemetry store (issue #32) — the daemon side of the
 * engine-owned {@link AgentTurnRecord} contract.
 *
 * The engine adapter produces turns from its own transcript; this store does
 * the ONE thing the engine can't: join them to Rove identity (task, tab,
 * vendor) and keep them across daemon restarts, so `rove api agent-turns`
 * can answer "what did this repo's agents actually do" later.
 *
 * Dedupe is by the engine's own turn id: a Stop hook re-reads the whole
 * transcript, so the same finished turn arrives on every subsequent turn's
 * ingest. Last write wins on the fields (a turn re-read after more assistant
 * records landed is the more complete one).
 */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { ROVE_STATE_DIR_BASENAME, readRoveEnv } from "../compat-env.ts"
import type { AgentTurnRecord } from "./contracts.ts"
import { logDaemonError } from "./crash-log.ts"

interface AgentTurnsFile {
  readonly version: 1
  readonly turns: AgentTurnRecord[]
}

/**
 * Cap on retained turns, newest kept. Per-turn records are ~200 bytes, so
 * this is a few MB worst case — enough for weeks of a busy machine, and the
 * store is telemetry, not an audit log.
 * ponytail: one flat cap, not per-task; revisit if a digest needs deeper history.
 */
const MAX_TURNS = 10_000

export function defaultAgentTurnsPath(homeDir = readRoveEnv("HOME_DIR") ?? homedir()): string {
  return join(homeDir, ROVE_STATE_DIR_BASENAME, "agent-turns.json")
}

function normalize(value: unknown): AgentTurnRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const t = value as Partial<AgentTurnRecord>
  if (typeof t.id !== "string" || t.id.length === 0) return null
  if (typeof t.taskId !== "string" || t.taskId.length === 0) return null
  if (typeof t.startedAt !== "number" || !Number.isFinite(t.startedAt)) return null
  if (typeof t.endedAt !== "number" || !Number.isFinite(t.endedAt)) return null
  return {
    id: t.id,
    taskId: t.taskId,
    ...(typeof t.tabId === "string" && t.tabId ? { tabId: t.tabId } : {}),
    ...(typeof t.vendor === "string" && t.vendor ? { vendor: t.vendor } : {}),
    ...(typeof t.sessionId === "string" && t.sessionId ? { sessionId: t.sessionId } : {}),
    ...(typeof t.model === "string" && t.model ? { model: t.model } : {}),
    ...(typeof t.repo === "string" && t.repo ? { repo: t.repo } : {}),
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    ...(t.usage && typeof t.usage === "object" ? { usage: t.usage } : {}),
  }
}

/** Turn key: the engine's id is unique per session, not globally (a resumed
 *  session could in principle repeat one), so scope it by task. */
function keyOf(turn: Pick<AgentTurnRecord, "taskId" | "id">): string {
  return `${turn.taskId}\0${turn.id}`
}

export class AgentTurnsStore {
  private readonly turns = new Map<string, AgentTurnRecord>()
  private tail: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  async init(): Promise<void> {
    await this.enqueue(async () => {
      this.turns.clear()
      for (const turn of await this.read()) this.turns.set(keyOf(turn), turn)
    })
  }

  /**
   * Merge a batch of turns for one task. Returns how many were NEW — the
   * ingest path uses that to skip the write when a re-read produced nothing
   * (the common case: every Stop re-reads the whole transcript).
   */
  async record(turns: readonly AgentTurnRecord[]): Promise<number> {
    return await this.enqueue(async () => {
      let added = 0
      for (const raw of turns) {
        const turn = normalize(raw)
        if (!turn) continue
        const key = keyOf(turn)
        if (!this.turns.has(key)) added++
        // Re-insert so Map order tracks recency; the cap evicts from the head.
        this.turns.delete(key)
        this.turns.set(key, turn)
      }
      if (added === 0) return 0
      while (this.turns.size > MAX_TURNS) {
        const oldest = this.turns.keys().next().value
        if (oldest === undefined) break
        this.turns.delete(oldest)
      }
      await this.write()
      return added
    })
  }

  /** Newest-first, optionally filtered. `limit` bounds the answer. */
  list(filter: { taskId?: string; repo?: string; since?: number; limit?: number } = {}): AgentTurnRecord[] {
    const limit = filter.limit && filter.limit > 0 ? filter.limit : 200
    const out: AgentTurnRecord[] = []
    for (const turn of this.turns.values()) {
      if (filter.taskId && turn.taskId !== filter.taskId) continue
      if (filter.repo && turn.repo !== filter.repo) continue
      if (filter.since !== undefined && turn.endedAt < filter.since) continue
      out.push(turn)
    }
    out.sort((a, b) => b.endedAt - a.endedAt)
    return out.slice(0, limit)
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.enqueue(async () => {
      let changed = false
      for (const [key, turn] of this.turns) {
        if (turn.taskId !== taskId) continue
        this.turns.delete(key)
        changed = true
      }
      if (changed) await this.write()
    })
  }

  private async read(): Promise<AgentTurnRecord[]> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<AgentTurnsFile>
      if (!Array.isArray(parsed.turns)) return []
      return parsed.turns.map(normalize).filter((t): t is AgentTurnRecord => t !== null)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
      logDaemonError("agent-turns-load", err)
      return []
    }
  }

  private async write(): Promise<void> {
    const body: AgentTurnsFile = { version: 1, turns: [...this.turns.values()] }
    const tmp = `${this.path}.tmp-${process.pid}-${randomUUID()}`
    try {
      await mkdir(dirname(this.path), { recursive: true })
      await writeFile(tmp, `${JSON.stringify(body)}\n`, "utf8")
      await rename(tmp, this.path)
    } catch (err) {
      logDaemonError("agent-turns-write", err)
    }
  }

  /** Serialize mutations so two concurrent hook ingests can't interleave a
   *  read-modify-write and lose turns. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work, work)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
