/**
 * Durable, daemon-owned attention Inbox.
 *
 * Live engine activity and Inbox retention are deliberately different state:
 * activity may idle on session close/archive, while a pending episode remains
 * until its target is visited/opened, the user dismisses it, that task+tab
 * starts another turn, or the containing task is explicitly hard-deleted. The
 * store persists a full snapshot so daemon/TUI reconnects cannot consume work
 * by accident.
 */

import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  type AttentionInboxItem,
  type AttentionInboxState,
  type EngineActivityDetail,
  type EngineActivityKind,
  attentionInboxItemKey,
  isAttentionInboxState,
} from "./contracts.ts"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"

interface AttentionInboxFile {
  readonly version: 1
  readonly items: AttentionInboxItem[]
}

export function defaultAttentionInboxPath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "attention-inbox.json")
}

function stateFor(kind: EngineActivityKind, detail?: EngineActivityDetail): AttentionInboxState | null {
  if (kind === "turn-complete") return "turn_complete"
  if (kind === "awaiting-input") return "permission_needed"
  if (kind !== "turn-failed") return null
  return detail?.failure === "rate_limit" ? "rate_limited" : "error"
}

function normalizeItem(value: unknown): AttentionInboxItem | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const item = value as Partial<AttentionInboxItem>
  if (typeof item.taskId !== "string" || item.taskId.length === 0) return null
  if (item.tabId !== null && typeof item.tabId !== "string") return null
  if (!isAttentionInboxState(item.state)) return null
  if (typeof item.at !== "number" || !Number.isFinite(item.at)) return null
  return {
    taskId: item.taskId,
    tabId: item.tabId,
    state: item.state,
    ...(item.detail ? { detail: item.detail } : {}),
    // All retained episodes are pending. Preserve the compatibility field
    // when loading snapshots, but the queue model no longer reads it.
    unread: item.unread !== false,
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
    logDaemonError("attention-inbox-load", err)
    return []
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
      for (const item of await readStore(this.path)) this.items.set(attentionInboxItemKey(item), item)
      this.publish()
    })
  }

  snapshot(): AttentionInboxItem[] {
    return [...this.items.values()].sort(compareItems)
  }

  async record(
    taskId: string,
    kind: EngineActivityKind,
    detail: EngineActivityDetail | undefined,
    tabId: string,
  ): Promise<void> {
    if (!tabId) throw new Error("AttentionInboxStore.record: tabId is required")
    await this.enqueue(async () => {
      const key = attentionInboxItemKey({ taskId, tabId })
      const next = new Map(this.items)
      if (kind === "turn-start") {
        if (!next.delete(key)) return
      } else {
        const state = stateFor(kind, detail)
        if (!state) return
        // Dedupe rule (owner 2026-07-16): one pending episode per task+tab —
        // a fresh event REPLACES the stale one and takes the latest position
        // (delete-then-set so the fresh `at` re-sorts it to the queue tail).
        next.delete(key)
        next.set(key, {
          taskId,
          tabId,
          state,
          ...(detail ? { detail } : {}),
          // Every stored episode is pending by definition (opening removes
          // it). Kept on the wire for old-client compatibility only.
          unread: true,
          at: this.now(),
        })
      }
      await this.commit(next)
    })
  }

  /**
   * Legacy RPC (pre queue-drain model): opening now DELETES the episode
   * (`deleteEpisode` via attention.dismiss). Kept for old clients whose
   * open still calls attention.markRead — treat it as the same resolve.
   */
  async markRead(taskId: string, tabId: string | null, at: number): Promise<boolean> {
    return await this.deleteEpisode(taskId, tabId, at)
  }

  /** Nullable tabId addresses legacy task-level data only; new writes require a tab. */
  async deleteEpisode(taskId: string, tabId: string | null, at?: number): Promise<boolean> {
    return await this.enqueue(async () => {
      const key = attentionInboxItemKey({ taskId, tabId })
      const item = this.items.get(key)
      if (!item || (at !== undefined && item.at !== at)) return false
      const next = new Map(this.items)
      next.delete(key)
      await this.commit(next)
      return true
    })
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.enqueue(async () => {
      const next = new Map(this.items)
      let changed = false
      for (const [key, item] of next) {
        if (item.taskId !== taskId) continue
        next.delete(key)
        changed = true
      }
      if (changed) await this.commit(next)
    })
  }

  /** Task deletion must continue even when Inbox persistence is unavailable. */
  async deleteTaskBestEffort(taskId: string): Promise<void> {
    await this.deleteTask(taskId).catch((err) => logDaemonError("attention-inbox-task-delete", err))
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.tail.then(operation)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Serialize mutations so concurrent hook/RPC writes cannot clobber the file. */
  private async commit(next: ReadonlyMap<string, AttentionInboxItem>): Promise<void> {
    const items = [...next.values()].sort(compareItems)
    await writeStore(this.path, items)
    this.items.clear()
    for (const item of items) this.items.set(attentionInboxItemKey(item), item)
    this.bus.publish("attention.inbox", { items })
  }

  private publish(): void {
    this.bus.publish("attention.inbox", { items: this.snapshot() })
  }
}

function compareItems(a: AttentionInboxItem, b: AttentionInboxItem): number {
  return a.at - b.at || a.taskId.localeCompare(b.taskId) || (a.tabId ?? "").localeCompare(b.tabId ?? "")
}
