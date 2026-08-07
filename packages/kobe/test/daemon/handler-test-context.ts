import type { DaemonRpcClient } from "@sma1lboy/kobe-daemon/client/rpc"
import type { DaemonActivityRegistry } from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import type { AttentionInboxStore } from "@sma1lboy/kobe-daemon/daemon/attention-inbox"
import type { AutomationsStore } from "@sma1lboy/kobe-daemon/daemon/automations-store"
import type { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import type { IssuesStore } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import type { QuotaUsageCache } from "@sma1lboy/kobe-daemon/daemon/quota-usage-cache"
import type { DaemonHandlerContext } from "@sma1lboy/kobe-daemon/daemon/server"
import type { SessionBindingStore } from "@sma1lboy/kobe-daemon/daemon/session-bindings"
import type { WorkItemCache } from "@sma1lboy/kobe-daemon/daemon/work-items"
import { daemonRuntime } from "../../src/core/daemon-runtime.ts"
import type { Orchestrator } from "../../src/orchestrator/core.ts"

export interface RecordedHandlerEffects {
  readonly published: Array<{ channel: string; payload: unknown }>
  readonly reported: Array<{ taskId: string; kind: string; detail?: unknown }>
  readonly issueCalls: Array<{ method: string; repo: unknown; op?: unknown }>
  readonly cleared: string[]
  readonly inboxRecords: Array<{ taskId: string; kind: string; detail?: unknown; tabId?: string }>
  readonly inboxDeleted: Array<{ taskId: string; tabId: string | null; at?: number }>
  readonly inboxRead: Array<{ taskId: string; tabId: string | null; at: number }>
  readonly inboxTaskDeleted: string[]
  readonly bindings: Array<Record<string, unknown>>
  readonly transitions: Array<Record<string, unknown>>
  readonly deletions: string[]
  stopped: number
  idleReevaluations: number
}

/** Build a handler context around a partial fake Orchestrator — no socket. */
export function fakeCtx(orch: Record<string, unknown> = {}): {
  ctx: DaemonHandlerContext
  rec: RecordedHandlerEffects
} {
  const rec: RecordedHandlerEffects = {
    published: [],
    reported: [],
    issueCalls: [],
    cleared: [],
    inboxRecords: [],
    inboxDeleted: [],
    inboxRead: [],
    inboxTaskDeleted: [],
    bindings: [],
    transitions: [],
    deletions: [],
    stopped: 0,
    idleReevaluations: 0,
  }
  const currentBindings: Record<string, Record<string, Record<string, unknown>>> = {}
  const ctx: DaemonHandlerContext = {
    runtime: daemonRuntime,
    orch: {
      listTasks: () => [],
      getTask: (taskId: string) => {
        const listTasks = orch.listTasks
        const tasks = typeof listTasks === "function" ? (listTasks as () => Array<{ id: string }>)() : []
        return tasks.find((task) => task.id === taskId)
      },
      ...orch,
    } as unknown as Orchestrator,
    bus: {
      publish: (channel: string, payload: unknown) => rec.published.push({ channel, payload }),
    } as unknown as DaemonEventBus,
    activity: {
      report: (taskId: string, kind: string, detail?: unknown) => rec.reported.push({ taskId, kind, detail }),
      clearTask: (taskId: string) => rec.cleared.push(taskId),
      pinTabSession: () => {},
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
    bindings: {
      begin: async (taskId: string, tabId: string, vendor: string) => {
        const value = { taskId, tabId, vendor, state: "pending" }
        rec.bindings.push(value)
        currentBindings[taskId] = { ...(currentBindings[taskId] ?? {}), [tabId]: value }
        return value
      },
      bind: async (value: Record<string, unknown>) => {
        rec.bindings.push(value)
        const taskId = String(value.taskId)
        const tabId = String(value.tabId)
        currentBindings[taskId] = { ...(currentBindings[taskId] ?? {}), [tabId]: value }
        return value
      },
      markTransition: (value: Record<string, unknown>) => {
        rec.transitions.push(value)
      },
      snapshotByTask: () => currentBindings,
      transitionSnapshotByTask: () => ({}),
      deleteTask: async () => {},
      deleteTaskBestEffort: async () => {},
    } as unknown as SessionBindingStore,
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
