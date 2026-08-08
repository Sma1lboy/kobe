import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import type { DaemonActivityRegistry } from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import type { AttentionInboxStore } from "@sma1lboy/kobe-daemon/daemon/attention-inbox"
import type { AutomationsStore } from "@sma1lboy/kobe-daemon/daemon/automations-store"
import type { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import type { IssuesStore } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import type { FieldNote, NotesStore } from "@sma1lboy/kobe-daemon/daemon/notes-store"
import type { QuotaUsageCache } from "@sma1lboy/kobe-daemon/daemon/quota-usage-cache"
import {
  type DaemonHandlerContext,
  createDaemonHandlerRegistry,
  dispatchDaemonRequest,
} from "@sma1lboy/kobe-daemon/daemon/server"
import type { WorkItemCache } from "@sma1lboy/kobe-daemon/daemon/work-items"
import { daemonRuntime } from "../../src/core/daemon-runtime.ts"
import type { Orchestrator } from "../../src/orchestrator/core.ts"
import type { Task } from "../../src/types/task.ts"

export interface RecordedHandlerEffects {
  readonly published: Array<{ channel: string; payload: unknown }>
  readonly reported: Array<{ taskId: string; kind: string; detail?: unknown }>
  readonly issueCalls: Array<{ method: string; repo: unknown; op?: unknown }>
  readonly noteCalls: Array<{ method: string; repo: unknown; note?: unknown }>
  readonly cleared: string[]
  readonly inboxRecords: Array<{ taskId: string; kind: string; detail?: unknown; tabId?: string }>
  readonly inboxDeleted: Array<{ taskId: string; tabId: string | null; at?: number }>
  readonly inboxRead: Array<{ taskId: string; tabId: string | null; at: number }>
  readonly inboxTaskDeleted: string[]
  readonly deletions: string[]
  stopped: number
  idleReevaluations: number
}

/**
 * Build a handler context around a partial fake Orchestrator — no socket.
 * Two non-orchestrator keys are read off the same bag for the field-note
 * store fake: `notes` (what `note.list` returns) and `noteAppendThrows`
 * (drive the persist-failure path).
 */
export function fakeCtx(orch: Record<string, unknown> = {}): {
  ctx: DaemonHandlerContext
  rec: RecordedHandlerEffects
} {
  const rec: RecordedHandlerEffects = {
    published: [],
    reported: [],
    issueCalls: [],
    noteCalls: [],
    cleared: [],
    inboxRecords: [],
    inboxDeleted: [],
    inboxRead: [],
    inboxTaskDeleted: [],
    deletions: [],
    stopped: 0,
    idleReevaluations: 0,
  }
  const ctx: DaemonHandlerContext = {
    runtime: daemonRuntime,
    orch: { listTasks: () => [], ...orch } as unknown as Orchestrator,
    bus: {
      publish: (channel: string, payload: unknown) => rec.published.push({ channel, payload }),
    } as unknown as DaemonEventBus,
    activity: {
      report: (taskId: string, kind: string, detail?: unknown) => rec.reported.push({ taskId, kind, detail }),
      clearTask: (taskId: string) => rec.cleared.push(taskId),
    } as unknown as DaemonActivityRegistry,
    inbox: {
      record: (taskId: string, kind: string, detail?: unknown, tabId?: string) => {
        rec.inboxRecords.push({ taskId, kind, detail, tabId })
        return Promise.resolve()
      },
      deleteEpisode: (taskId: string, tabId: string | null, at?: number) => {
        rec.inboxDeleted.push({ taskId, tabId, ...(at !== undefined ? { at } : {}) })
        return Promise.resolve(true)
      },
      markRead: (taskId: string, tabId: string | null, at: number) => {
        rec.inboxRead.push({ taskId, tabId, at })
        return Promise.resolve(true)
      },
      deleteTask: (taskId: string) => {
        rec.inboxTaskDeleted.push(taskId)
        return Promise.resolve()
      },
      deleteTaskBestEffort: (taskId: string) => {
        rec.inboxTaskDeleted.push(taskId)
        return Promise.resolve()
      },
    } as unknown as AttentionInboxStore,
    deletions: {
      enqueue: (taskId: string) => rec.deletions.push(taskId),
    },
    // A cache that never fetches: handler tests exercise the RPC surface,
    // not the probe cadence (quota-usage-cache has its own suite).
    quotaUsage: {
      peek: () => null,
      get: () => Promise.resolve(null),
      refreshIfDue: () => Promise.resolve(),
    } as unknown as QuotaUsageCache,
    issues: {
      list: async (repo: unknown) => {
        rec.issueCalls.push({ method: "list", repo })
        return { repoRoot: String(repo), exists: false, nextId: 1, issues: [] }
      },
      mutate: async (repo: unknown, op: unknown) => {
        rec.issueCalls.push({ method: "mutate", repo, op })
        return { repoRoot: String(repo), exists: true, nextId: 2, issues: [] }
      },
    } as unknown as IssuesStore,
    // Field-note store fake. `appendThrows` lets a test drive the
    // persist-failure path — filing must degrade to routing-only, never
    // error the agent that filed the note.
    notes: {
      list: async (repo: unknown) => {
        rec.noteCalls.push({ method: "list", repo })
        return (orch.notes as FieldNote[] | undefined) ?? []
      },
      append: async (repo: unknown, note: unknown) => {
        rec.noteCalls.push({ method: "append", repo, note })
        if (orch.noteAppendThrows) throw new Error("disk on fire")
      },
    } as unknown as NotesStore,
    // Empty schedule store: automation behavior has its own suites
    // (automations-store / automation-runner), so handler tests only need the
    // surface to exist.
    automations: {
      list: () => [],
      get: () => undefined,
      runsFor: () => [],
      hasEnabled: () => false,
      create: async (input: unknown) => input,
      update: async () => null,
      delete: async () => false,
      recordRun: async (input: unknown) => input,
      advanceNextRun: async () => null,
    } as unknown as AutomationsStore,
    // Never hits `gh`: work-item behavior has its own suite.
    workItems: { list: async () => [], clear: () => {} } as unknown as WorkItemCache,
    selfLink: { request: async () => ({}) } as unknown as DaemonRpcClient,
    daemon: {
      startedAt: new Date("2026-06-01T00:00:00.000Z"),
      socketPath: "/tmp/fake/daemon.sock",
      pid: 4242,
      guiCount: () => 1,
      stopSoon: async () => {
        rec.stopped++
      },
      reevaluateIdle: () => {
        rec.idleReevaluations++
      },
    },
    clientId: 7,
  }
  return { ctx, rec }
}

/**
 * Task fixture + wire snapshot + the dispatch shim, shared by the two
 * registry suites (`handlers.test.ts` and `handlers-task-crud.test.ts`).
 * They live here rather than in either suite so neither imports the other.
 */
export const TASK: Task = {
  id: "t1",
  title: "demo task",
  repo: "/repo",
  branch: "kobe/demo",
  worktreePath: "/repo/.kobe/worktrees/demo",
  kind: "task",
  status: "in_progress",
  archived: false,
  pinned: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
} as Task

/** What `serializeTask(TASK)` puts on the wire (pinned literally on purpose). */
export const SERIALIZED_TASK = {
  id: "t1",
  title: "demo task",
  repo: "/repo",
  branch: "kobe/demo",
  worktreePath: "/repo/.kobe/worktrees/demo",
  kind: "task",
  status: "in_progress",
  archived: false,
  pinned: false,
  vendor: undefined,
  prStatus: undefined,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
}

export function dispatch(name: string, payload: unknown, ctx: DaemonHandlerContext): Promise<unknown> {
  return dispatchDaemonRequest(createDaemonHandlerRegistry(), name, payload, ctx)
}
