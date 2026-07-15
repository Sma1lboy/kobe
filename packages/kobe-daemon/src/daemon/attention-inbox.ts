/**
 * Durable, daemon-owned attention Inbox.
 *
 * Live engine activity and Inbox retention are deliberately different state:
 * activity may idle on session close/archive, while an unresolved episode must
 * remain until that exact task+tab starts another turn or the user dismisses
 * it. The store persists a full snapshot so daemon/TUI reconnects cannot
 * consume work by accident.
 */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { AttentionInboxItem, AttentionInboxState, EngineActivityDetail, EngineActivityKind } from "./contracts.ts"
import type { DaemonEventBus } from "./event-bus.ts"

interface AttentionInboxFile {
  readonly version: 1
  readonly items: AttentionInboxItem[]
}

export function defaultAttentionInboxPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "attention-inbox.json")
}

function itemKey(taskId: string, tabId: string | null): string {
  return `${taskId}\0${tabId ?? ""}`
}

function stateFor(kind: EngineActivityKind, detail?: EngineActivityDetail): AttentionInboxState | null {
  if (kind === "turn-complete") return "turn_complete"
  if (kind === "awaiting-input") return "permission_needed"
  if (kind !== "turn-failed") return null
  return detail?.failure === "rate_limit" || detail?.failure === "billing" ? "rate_limited" : "error"
}

function normalizeItem(value: unknown): AttentionInboxItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const item = value as Partial<AttentionInboxItem>
  if (typeof item.taskId !== "string" || item.taskId.length === 0) return null
  if (item.tabId !== null && typeof item.tabId !== "string") return null
  if (
    item.state !== "turn_complete" &&
    item.state !== "permission_needed" &&
    item.state !== "error" &&
    item.state !== "rate_limited"
  )
    return null
  if (typeof item.at !== "number" || !Number.isFinite(item.at)) return null
  return {
    taskId: item.taskId,
    tabId: item.tabId,
    state: item.state,
    ...(item.detail ? { detail: item.detail } : {}),
    at: item.at,
  }
}

async function readStore(path: string): Promise<AttentionInboxItem[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<AttentionInboxFile>
    if (!Array.isArray(parsed.items)) return []
    return parsed.items.map(normalizeItem).filter((item): item is AttentionInboxItem => item !== null)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return []
    throw err
  }
}

async function writeStore(path: string, items: readonly AttentionInboxItem[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  const body: AttentionInboxFile = { version: 1, items: [...items] }
  await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

export class AttentionInboxStore {
  private readonly items = new Map<string, AttentionInboxItem>()
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly bus: DaemonEventBus,
    private readonly now = () => Date.now(),
  ) {}

  async init(): Promise<void> {
    await this.enqueue(async () => {
      this.items.clear()
      for (const item of await readStore(this.path)) this.items.set(itemKey(item.taskId, item.tabId), item)
      this.publish()
    })
  }

  snapshot(): AttentionInboxItem[] {
    return [...this.items.values()].sort(
      (a, b) => a.at - b.at || a.taskId.localeCompare(b.taskId) || (a.tabId ?? "").localeCompare(b.tabId ?? ""),
    )
  }

  async record(taskId: string, kind: EngineActivityKind, detail?: EngineActivityDetail, tabId?: string): Promise<void> {
    await this.enqueue(async () => {
      const key = itemKey(taskId, tabId ?? null)
      if (kind === "turn-start") {
        if (!this.items.delete(key)) return
      } else {
        const state = stateFor(kind, detail)
        if (!state) return
        this.items.set(key, {
          taskId,
          tabId: tabId ?? null,
          state,
          ...(detail ? { detail } : {}),
          at: this.now(),
        })
      }
      await this.persistAndPublish()
    })
  }

  async deleteEpisode(taskId: string, tabId: string | null): Promise<boolean> {
    return await this.enqueue(async () => {
      if (!this.items.delete(itemKey(taskId, tabId))) return false
      await this.persistAndPublish()
      return true
    })
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.enqueue(async () => {
      let changed = false
      for (const [key, item] of this.items) {
        if (item.taskId !== taskId) continue
        this.items.delete(key)
        changed = true
      }
      if (changed) await this.persistAndPublish()
    })
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async persistAndPublish(): Promise<void> {
    const items = this.snapshot()
    await writeStore(this.path, items)
    this.bus.publish("attention.inbox", { items })
  }

  private publish(): void {
    this.bus.publish("attention.inbox", { items: this.snapshot() })
  }
}
