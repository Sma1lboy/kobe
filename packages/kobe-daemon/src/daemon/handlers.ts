import { isEngineActivityKind } from "@/engine/hook-events"
import { maybeAutoStart } from "@/monitor/status-rules"
import type { Orchestrator } from "@/orchestrator/core"
import { CURRENT_VERSION } from "@/version"
import type { DaemonActivityRegistry } from "./activity-registry.ts"
import { logDaemonError } from "./crash-log.ts"
import { findAdoptableWorktree, matchTaskByCwd } from "./cwd-task.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import { objectPayload, optionalActivityDetail, optionalString, requireString } from "./handler-validators.ts"
import { TASK_HANDLERS } from "./handlers-task.ts"
import { WORKTREE_HANDLERS } from "./handlers-worktree.ts"
import type { IssuesStore } from "./issues-store.ts"
import {
  CHANNEL_NAMES,
  DAEMON_PROTOCOL_VERSION,
  type DaemonError,
  type DaemonRequestName,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  isProtocolCompatible,
  serializeTask,
} from "./protocol.ts"

export {
  objectPayload,
  optionalActivityDetail,
  optionalBoolean,
  optionalString,
  optionalVendor,
  requireString,
} from "./handler-validators.ts"

export interface DaemonHandlerContext {
  readonly orch: Orchestrator
  readonly bus: DaemonEventBus
  readonly activity: DaemonActivityRegistry
  readonly issues: IssuesStore
  readonly daemon: {
    readonly startedAt: Date
    readonly socketPath: string
    readonly webPort?: number
    readonly pid: number
    guiCount(): number
    stopSoon(): Promise<void>
  }
  readonly clientId: number
}

export interface DaemonRequestHandler {
  readonly name: DaemonRequestName
  handle(payload: Record<string, unknown>, ctx: DaemonHandlerContext): Promise<unknown> | unknown
}

export function shapeDaemonError(err: unknown): DaemonError {
  return {
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : undefined,
  }
}

export async function dispatchDaemonRequest(
  registry: ReadonlyMap<DaemonRequestName, DaemonRequestHandler>,
  name: string,
  payload: unknown,
  ctx: DaemonHandlerContext,
): Promise<unknown> {
  const entry = registry.get(name as DaemonRequestName)
  if (!entry) throw new Error(`unknown daemon request: ${name}`)
  return entry.handle(objectPayload(payload), ctx)
}

export function createDaemonHandlerRegistry(): ReadonlyMap<DaemonRequestName, DaemonRequestHandler> {
  const entries: DaemonRequestHandler[] = [
    {
      name: "hello",
      handle(payload, ctx) {
        const clientVersion =
          typeof payload.protocolVersion === "number" ? payload.protocolVersion : DAEMON_PROTOCOL_VERSION
        const clientMin = typeof payload.minProtocolVersion === "number" ? payload.minProtocolVersion : clientVersion
        if (
          !isProtocolCompatible({
            localVersion: DAEMON_PROTOCOL_VERSION,
            localMin: MIN_COMPATIBLE_PROTOCOL_VERSION,
            remoteVersion: clientVersion,
            remoteMin: clientMin,
          })
        ) {
          throw new Error(
            `daemon is protocol v${DAEMON_PROTOCOL_VERSION} (min v${MIN_COMPATIBLE_PROTOCOL_VERSION}); this client is v${clientVersion} (min v${clientMin}). Upgrade your kobe.`,
          )
        }
        return {
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          minProtocolVersion: MIN_COMPATIBLE_PROTOCOL_VERSION,
          kobeVersion: CURRENT_VERSION,
          capabilities: [...CHANNEL_NAMES],
          daemonPid: ctx.daemon.pid,
          clientId: ctx.clientId,
          tasks: ctx.orch.listTasks().map(serializeTask),
        }
      },
    },
    {
      name: "daemon.status",
      handle(_payload, ctx) {
        return {
          daemonPid: ctx.daemon.pid,
          kobeVersion: CURRENT_VERSION,
          uptimeMs: Date.now() - ctx.daemon.startedAt.getTime(),
          startedAt: ctx.daemon.startedAt.toISOString(),
          attachedClients: ctx.daemon.guiCount(),
          taskCount: ctx.orch.listTasks().length,
          socketPath: ctx.daemon.socketPath,
          webPort: ctx.daemon.webPort ?? null,
        }
      },
    },
    {
      name: "daemon.stop",
      async handle(_payload, ctx) {
        await ctx.daemon.stopSoon()
        return {}
      },
    },
    ...TASK_HANDLERS,
    ...WORKTREE_HANDLERS,
    {
      name: "issue.list",
      async handle(payload, ctx) {
        return ctx.issues.list(requireString(payload, "repoRoot"))
      },
    },
    {
      name: "issue.mutate",
      async handle(payload, ctx) {
        const state = await ctx.issues.mutate(requireString(payload, "repoRoot"), payload.op)
        ctx.bus.publish("issue.snapshot", state)
        return state
      },
    },
    {
      name: "session.deliver",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        const text = requireString(payload, "text")
        const source = optionalString(payload, "source")
        if (source !== undefined && source !== "note" && source !== "dispatcher") {
          throw new Error('source must be "note" or "dispatcher"')
        }
        if (!ctx.orch.getTask(taskId)) throw new Error(`task not found: ${taskId}`)
        ctx.bus.publish("session.deliver", {
          taskId,
          text,
          at: Date.now(),
          source: source ?? "dispatcher",
        })
        return { ok: true }
      },
    },
    {
      name: "note.file",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        const text = requireString(payload, "text")
        const author = ctx.orch.getTask(taskId)
        if (!author) throw new Error(`task not found: ${taskId}`)
        const main = ctx.orch
          .listTasks()
          .find((t) => (t.kind ?? "task") === "main" && t.repo === author.repo && !t.archived)
        if (!main || main.id === author.id) return { ok: true, routed: false }
        const label = author.title || author.branch || taskId
        ctx.bus.publish("session.deliver", {
          taskId: main.id,
          text: `[KOBE FIELD NOTE] from "${label}" (task ${taskId}): ${text}`,
          at: Date.now(),
          source: "note",
        })
        return { ok: true, routed: true }
      },
    },
    {
      name: "engine.reportEvent",
      async handle(payload, ctx) {
        const kind = requireString(payload, "kind")
        if (!isEngineActivityKind(kind)) throw new Error(`unknown engine event kind: ${kind}`)
        const explicitId = optionalString(payload, "taskId")
        const cwd = optionalString(payload, "cwd")
        if (!explicitId && cwd && kind === "session-start") {
          const cand = findAdoptableWorktree(ctx.orch.listTasks(), cwd)
          if (cand) {
            try {
              await ctx.orch.adoptWorktree({ repo: cand.repo, worktreePath: cand.worktreePath, ifExists: "return" })
            } catch (err) {
              logDaemonError("worktree-autosync", err)
            }
          }
        }
        const taskId = explicitId ?? (cwd ? matchTaskByCwd(ctx.orch.listTasks(), cwd) : undefined)
        if (!taskId) return {}
        const detail = optionalActivityDetail(payload)
        ctx.activity.report(taskId, kind, detail)
        if (kind === "turn-start") {
          maybeAutoStart(ctx.orch, taskId)
            .then((result) => {
              if (result === "moved") {
                console.log(`[status-rules] task ${taskId} auto-moved backlog → in_progress`)
              }
            })
            .catch((err) => logDaemonError("status-rules", err))
        }
        return {}
      },
    },
  ]
  return new Map(entries.map((entry) => [entry.name, entry]))
}
