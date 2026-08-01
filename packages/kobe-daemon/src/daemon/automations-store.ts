/**
 * Durable, daemon-owned Automations store.
 *
 * Shape copied from {@link AttentionInboxStore}: an in-memory map fronting one
 * whole-file JSON document, mutations serialized through a promise tail, writes
 * via tmp+rename. The daemon is the only writer, so no cross-process lockfile
 * (that is `tasks.json`'s problem, where the CLI and TUI write too).
 *
 * In-memory rather than `IssuesStore`'s read-on-every-call because the runner
 * sweeps this every 60s; re-reading the file each tick would be pure waste.
 *
 * Corruption policy follows the inbox, not the issue store: log and start empty.
 * A malformed automations file must never keep the daemon from booting.
 */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Automation, AutomationPatch, AutomationRun } from "./contracts.ts"
import { logDaemonError } from "./crash-log.ts"
import { nextCronAfter } from "./cron.ts"

/** Per-automation run history cap. The whole document is re-serialized on every
 *  write, so an unbounded log makes each save permanently slower. */
export const MAX_RUNS_PER_AUTOMATION = 100

interface AutomationsFile {
  readonly version: 1
  readonly automations: Automation[]
  readonly runs: AutomationRun[]
}

export function defaultAutomationsPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "automations.json")
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function normalizeAutomation(value: unknown): Automation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Partial<Automation>
  const id = str(raw.id)
  const name = str(raw.name)
  const repo = str(raw.repo)
  const prompt = str(raw.prompt)
  const schedule = str(raw.schedule)
  const nextRunAt = str(raw.nextRunAt)
  if (!id || !name || !repo || !prompt || !schedule || !nextRunAt) return null
  if (!Number.isFinite(Date.parse(nextRunAt))) return null

  const precheckCommand = str(raw.precheck?.command)
  const grace = raw.missedRunGraceMinutes
  const now = new Date().toISOString()
  return {
    id,
    name,
    repo,
    prompt,
    schedule,
    nextRunAt,
    enabled: raw.enabled !== false,
    missedRunGraceMinutes: typeof grace === "number" && Number.isFinite(grace) && grace >= 0 ? grace : 60,
    ...(raw.vendor ? { vendor: raw.vendor } : {}),
    ...(precheckCommand
      ? {
          precheck: {
            command: precheckCommand,
            timeoutSeconds:
              typeof raw.precheck?.timeoutSeconds === "number" && raw.precheck.timeoutSeconds > 0
                ? raw.precheck.timeoutSeconds
                : 120,
          },
        }
      : {}),
    ...(str(raw.baseRef) ? { baseRef: raw.baseRef } : {}),
    ...(str(raw.lastRunAt) ? { lastRunAt: raw.lastRunAt } : {}),
    createdAt: str(raw.createdAt) ?? now,
    updatedAt: str(raw.updatedAt) ?? now,
  }
}

function normalizeRun(value: unknown): AutomationRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Partial<AutomationRun>
  const id = str(raw.id)
  const automationId = str(raw.automationId)
  const scheduledFor = str(raw.scheduledFor)
  const at = str(raw.at)
  if (!id || !automationId || !scheduledFor || !at) return null
  if (
    raw.status !== "dispatched" &&
    raw.status !== "skipped_precheck" &&
    raw.status !== "skipped_missed" &&
    raw.status !== "skipped_unavailable" &&
    raw.status !== "dispatch_failed"
  ) {
    return null
  }
  return {
    id,
    automationId,
    runNumber: typeof raw.runNumber === "number" && raw.runNumber > 0 ? raw.runNumber : 1,
    scheduledFor,
    status: raw.status,
    trigger: raw.trigger === "manual" ? "manual" : "scheduled",
    ...(str(raw.taskId) ? { taskId: raw.taskId } : {}),
    ...(raw.precheckResult ? { precheckResult: raw.precheckResult } : {}),
    ...(str(raw.error) ? { error: raw.error } : {}),
    at,
  }
}

async function readStore(path: string): Promise<{ automations: Automation[]; runs: AutomationRun[] }> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AutomationsFile>
    const automations = Array.isArray(parsed.automations)
      ? parsed.automations.map(normalizeAutomation).filter((a): a is Automation => a !== null)
      : []
    const runs = Array.isArray(parsed.runs)
      ? parsed.runs.map(normalizeRun).filter((r): r is AutomationRun => r !== null)
      : []
    return { automations, runs }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { automations: [], runs: [] }
    logDaemonError("automations-load", err)
    return { automations: [], runs: [] }
  }
}

async function writeStore(path: string, automations: readonly Automation[], runs: readonly AutomationRun[]) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  const body: AutomationsFile = { version: 1, automations: [...automations], runs: [...runs] }
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

/**
 * Keep the newest {@link MAX_RUNS_PER_AUTOMATION} runs per automation.
 *
 * `deletedAutomationIds` drops the history of automations the user explicitly
 * removed. It is an opt-IN list rather than "keep only what's live" on purpose:
 * a run is written by the runner while the store may be mid-mutation, and
 * treating every unrecognized id as garbage would silently eat legitimate
 * records. Retention should never be the reason a run disappears.
 *
 * Newest-first by `at`, ties broken by `runNumber` so the order is
 * deterministic within a millisecond.
 */
export function pruneRuns(
  runs: readonly AutomationRun[],
  deletedAutomationIds: ReadonlySet<string> = new Set(),
  maxPer = MAX_RUNS_PER_AUTOMATION,
): AutomationRun[] {
  const byAutomation = new Map<string, AutomationRun[]>()
  for (const run of runs) {
    if (deletedAutomationIds.has(run.automationId)) continue
    const list = byAutomation.get(run.automationId)
    if (list) list.push(run)
    else byAutomation.set(run.automationId, [run])
  }
  const kept = new Set<string>()
  for (const list of byAutomation.values()) {
    list.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.runNumber - a.runNumber)
    for (const run of list.slice(0, Math.max(0, maxPer))) kept.add(run.id)
  }
  // Survivors keep their original append order — callers read this as a log.
  return runs.filter((run) => kept.has(run.id))
}

export class AutomationsStore {
  private automations: Automation[] = []
  private runs: AutomationRun[] = []
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly now = () => Date.now(),
  ) {}

  async init(): Promise<void> {
    await this.enqueue(async () => {
      const loaded = await readStore(this.path)
      this.automations = loaded.automations
      this.runs = loaded.runs
    })
  }

  list(): Automation[] {
    return [...this.automations]
  }

  get(id: string): Automation | undefined {
    return this.automations.find((a) => a.id === id)
  }

  /** Runs for one automation, newest first. */
  runsFor(automationId: string, limit = MAX_RUNS_PER_AUTOMATION): AutomationRun[] {
    return this.runs
      .filter((run) => run.automationId === automationId)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || b.runNumber - a.runNumber)
      .slice(0, limit)
  }

  /** True when any enabled automation exists — the daemon's keep-alive gate. */
  hasEnabled(): boolean {
    return this.automations.some((a) => a.enabled)
  }

  async create(
    input: Omit<Automation, "id" | "nextRunAt" | "createdAt" | "updatedAt" | "enabled"> & { enabled?: boolean },
  ): Promise<Automation> {
    return await this.enqueue(async () => {
      const nowMs = this.now()
      const iso = new Date(nowMs).toISOString()
      const automation: Automation = {
        ...input,
        id: randomUUID(),
        enabled: input.enabled !== false,
        // Throws on an expression that parses but never fires — better to fail
        // the create than to persist a schedule that silently never runs.
        nextRunAt: new Date(nextCronAfter(input.schedule, nowMs)).toISOString(),
        createdAt: iso,
        updatedAt: iso,
      }
      this.automations = [...this.automations, automation]
      await this.commit()
      return automation
    })
  }

  async update(id: string, patch: AutomationPatch): Promise<Automation | null> {
    return await this.enqueue(async () => {
      const index = this.automations.findIndex((a) => a.id === id)
      if (index === -1) return null
      const current = this.automations[index] as Automation
      const nowMs = this.now()
      const schedule = patch.schedule ?? current.schedule
      const next: Automation = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.vendor !== undefined ? { vendor: patch.vendor } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.missedRunGraceMinutes !== undefined ? { missedRunGraceMinutes: patch.missedRunGraceMinutes } : {}),
        schedule,
        // A cleared precheck/baseRef must actually disappear from the record,
        // so `null` deletes rather than storing a null.
        ...(patch.precheck === null
          ? { precheck: undefined }
          : patch.precheck !== undefined
            ? { precheck: patch.precheck }
            : {}),
        ...(patch.baseRef === null
          ? { baseRef: undefined }
          : patch.baseRef !== undefined
            ? { baseRef: patch.baseRef }
            : {}),
        // Re-anchor the schedule whenever the expression changes, else the old
        // nextRunAt would fire on a rule the user just replaced.
        ...(patch.schedule !== undefined ? { nextRunAt: new Date(nextCronAfter(schedule, nowMs)).toISOString() } : {}),
        updatedAt: new Date(nowMs).toISOString(),
      }
      this.automations = this.automations.map((a, i) => (i === index ? next : a))
      await this.commit()
      return next
    })
  }

  async delete(id: string): Promise<boolean> {
    return await this.enqueue(async () => {
      if (!this.automations.some((a) => a.id === id)) return false
      this.automations = this.automations.filter((a) => a.id !== id)
      // Deleting an automation takes its run history with it — named
      // explicitly, since retention alone never drops an unknown id.
      await this.commit(new Set([id]))
      return true
    })
  }

  /**
   * Move the schedule past `afterMs` and stamp `lastRunAt`. Called BEFORE the
   * run is dispatched so an overlapping sweep can never fire the same
   * occurrence twice.
   */
  async advanceNextRun(id: string, afterMs: number): Promise<Automation | null> {
    return await this.enqueue(async () => {
      const index = this.automations.findIndex((a) => a.id === id)
      if (index === -1) return null
      const current = this.automations[index] as Automation
      const iso = new Date(afterMs).toISOString()
      let nextRunAt: string
      try {
        nextRunAt = new Date(nextCronAfter(current.schedule, afterMs)).toISOString()
      } catch (err) {
        // A stored schedule that no longer resolves (hand-edited file, or a
        // once-only date now in the past) must not wedge the sweep on a
        // permanently-due row: disable it and surface it in `automation-list`.
        logDaemonError("automations-advance", err)
        const disabled: Automation = { ...current, enabled: false, lastRunAt: iso, updatedAt: iso }
        this.automations = this.automations.map((a, i) => (i === index ? disabled : a))
        await this.commit()
        return disabled
      }
      const next: Automation = { ...current, nextRunAt, lastRunAt: iso, updatedAt: iso }
      this.automations = this.automations.map((a, i) => (i === index ? next : a))
      await this.commit()
      return next
    })
  }

  async recordRun(input: Omit<AutomationRun, "id" | "runNumber">): Promise<AutomationRun> {
    return await this.enqueue(async () => {
      // Continue from the highest number this automation carries, NOT from the
      // retained count — pruning would otherwise reissue numbers.
      const runNumber =
        this.runs.reduce((n, run) => (run.automationId === input.automationId ? Math.max(n, run.runNumber) : n), 0) + 1
      const run: AutomationRun = { ...input, id: randomUUID(), runNumber }
      this.runs = [...this.runs, run]
      await this.commit()
      return run
    })
  }

  private async commit(deletedAutomationIds?: ReadonlySet<string>): Promise<void> {
    this.runs = pruneRuns(this.runs, deletedAutomationIds)
    await writeStore(this.path, this.automations, this.runs)
  }

  /** Serialize mutations so concurrent RPC/sweep writes cannot clobber the file. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
