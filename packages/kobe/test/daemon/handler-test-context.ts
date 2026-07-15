import type { DaemonActivityRegistry } from "@sma1lboy/kobe-daemon/daemon/activity-registry"
import type { AttentionInboxStore } from "@sma1lboy/kobe-daemon/daemon/attention-inbox"
import type { DaemonEventBus } from "@sma1lboy/kobe-daemon/daemon/event-bus"
import type { IssuesStore } from "@sma1lboy/kobe-daemon/daemon/issues-store"
import type { DaemonHandlerContext } from "@sma1lboy/kobe-daemon/daemon/server"
import { daemonRuntime } from "../../src/core/daemon-runtime.ts"
import type { Orchestrator } from "../../src/orchestrator/core.ts"

export interface RecordedHandlerEffects {
  readonly published: Array<{ channel: string; payload: unknown }>
  readonly reported: Array<{ taskId: string; kind: string; detail?: unknown }>
  readonly issueCalls: Array<{ method: string; repo: unknown; op?: unknown }>
  readonly cleared: string[]
  readonly inboxRecords: Array<{ taskId: string; kind: string; detail?: unknown; tabId?: string }>
  readonly inboxDeleted: Array<{ taskId: string; tabId: string | null }>
  readonly inboxRead: Array<{ taskId: string; tabId: string | null; at: number }>
  readonly inboxTaskDeleted: string[]
  readonly deletions: string[]
  stopped: number
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
    deletions: [],
    stopped: 0,
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
      deleteEpisode: (taskId: string, tabId: string | null) => {
        rec.inboxDeleted.push({ taskId, tabId })
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
    daemon: {
      startedAt: new Date("2026-06-01T00:00:00.000Z"),
      socketPath: "/tmp/fake/daemon.sock",
      pid: 4242,
      guiCount: () => 1,
      stopSoon: async () => {
        rec.stopped++
      },
    },
    clientId: 7,
  }
  return { ctx, rec }
}
