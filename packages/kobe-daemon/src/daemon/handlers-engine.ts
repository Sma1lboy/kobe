/** Engine lifecycle, session-binding, and resume-observation RPC handlers. */

import { logDaemonError } from "./crash-log.ts"
import { findAdoptableWorktree, matchTaskByCwd } from "./cwd-task.ts"
import {
  optionalActivityDetail,
  optionalSessionStartSource,
  optionalString,
  requireNumber,
  requireString,
} from "./handler-validators.ts"
import type { DaemonRequestHandler } from "./handlers.ts"
import { scheduleQuotaResume } from "./quota-resume.ts"
import { recoverSessionIdentity } from "./session-binding-recovery.ts"

export const ENGINE_HANDLERS: readonly DaemonRequestHandler[] = [
  {
    name: "engine.beginSession",
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const tabId = requireString(payload, "tabId")
      const task = ctx.orch.getTask(taskId)
      if (!task) throw new Error(`task not found: ${taskId}`)
      const vendor = optionalString(payload, "vendor") ?? task.vendor ?? ctx.runtime.defaultTaskVendor
      await ctx.bindings.begin(taskId, tabId, vendor)
      return {}
    },
  },
  {
    name: "engine.pinSession",
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const tabId = requireString(payload, "tabId")
      const sessionId = requireString(payload, "sessionId")
      const task = ctx.orch.getTask(taskId)
      if (!task) throw new Error(`task not found: ${taskId}`)
      const vendor = optionalString(payload, "vendor") ?? task.vendor ?? ctx.runtime.defaultTaskVendor
      await ctx.bindings.bind({ taskId, tabId, vendor, sessionId, source: "spawn" })
      ctx.activity.pinTabSession(taskId, tabId, sessionId)
      return {}
    },
  },
  {
    name: "engine.watchSession",
    web: true,
    handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const tabId = requireString(payload, "tabId")
      const rootPid = requireNumber(payload, "rootPid")
      const startedAt = requireNumber(payload, "startedAt")
      if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error("rootPid must be a positive integer")
      if (!Number.isFinite(startedAt) || startedAt < 0) throw new Error("startedAt must be a non-negative number")
      const task = ctx.orch.getTask(taskId)
      if (!task) throw new Error(`task not found: ${taskId}`)
      const vendor = optionalString(payload, "vendor") ?? task.vendor ?? ctx.runtime.defaultTaskVendor
      ctx.engineSessionMonitor.watch({ taskId, tabId, vendor, rootPid, startedAt })
      return { watching: true }
    },
  },
  {
    name: "engine.unwatchSession",
    web: true,
    handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const tabId = requireString(payload, "tabId")
      const rootPid = requireNumber(payload, "rootPid")
      if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error("rootPid must be a positive integer")
      return { removed: ctx.engineSessionMonitor.unwatch({ taskId, tabId, rootPid }) }
    },
  },
  {
    name: "engine.observeSession",
    // Backward-compatible one-shot path. New sidecars lease a continuous
    // daemon monitor through engine.watchSession instead.
    web: true,
    async handle(payload, ctx) {
      const taskId = requireString(payload, "taskId")
      const tabId = requireString(payload, "tabId")
      const rootPid = requireNumber(payload, "rootPid")
      if (!Number.isInteger(rootPid) || rootPid <= 0) throw new Error("rootPid must be a positive integer")
      const task = ctx.orch.getTask(taskId)
      if (!task) throw new Error(`task not found: ${taskId}`)
      const vendor = optionalString(payload, "vendor") ?? task.vendor ?? ctx.runtime.defaultTaskVendor
      const current = ctx.bindings.snapshotByTask()[taskId]?.[tabId]
      const activation = await ctx.runtime.observeEngineSessionActivation(vendor, rootPid, current?.updatedAt ?? 0)
      if (!activation) return { observed: false }
      if (activation.phase === "pending") {
        ctx.bindings.markTransition({
          taskId,
          tabId,
          vendor,
          startSource: activation.source,
          observedAt: activation.observedAt,
        })
        return { observed: true, pending: true }
      }
      await ctx.bindings.bind({
        taskId,
        tabId,
        vendor,
        sessionId: activation.sessionId,
        source: "observer",
        startSource: activation.source,
        ...(activation.transcriptPath ? { transcriptPath: activation.transcriptPath } : {}),
      })
      ctx.activity.pinTabSession(taskId, tabId, activation.sessionId)
      return { observed: true, pending: false, sessionId: activation.sessionId }
    },
  },
  {
    name: "engine.reportEvent",
    async handle(payload, ctx) {
      // Vendor hooks arrive normalized here; unmatched cwd events are dropped.
      const kind = requireString(payload, "kind")
      if (!ctx.runtime.isEngineActivityKind(kind)) throw new Error(`unknown engine event kind: ${kind}`)
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
      const tabId = optionalString(payload, "tabId")
      const task = ctx.orch.getTask(taskId)
      const reportedVendor = optionalString(payload, "engine")
      const vendor = reportedVendor ?? task?.vendor ?? ctx.runtime.defaultTaskVendor
      const recovered = await recoverSessionIdentity({
        runtime: ctx.runtime,
        kind,
        tabId,
        vendor,
        worktreePath: task?.worktreePath,
        sessionId: optionalString(payload, "sessionId"),
        transcriptPath: optionalString(payload, "transcriptPath"),
      })
      const { sessionId, transcriptPath } = recovered
      const startSource = optionalSessionStartSource(payload, "sessionStartSource")
      const session = sessionId ? { id: sessionId, transcriptPath } : undefined
      if (tabId && sessionId) {
        await ctx.bindings
          .bind({
            taskId,
            tabId,
            vendor,
            sessionId,
            source: recovered.source,
            eventKind: kind,
            ...(startSource ? { startSource } : {}),
            ...(transcriptPath ? { transcriptPath } : {}),
            ...(kind === "session-end" ? { state: "ended" } : {}),
          })
          .catch((err) => logDaemonError("session-bindings-hook", err))
      }
      const isStateKind = ctx.runtime.affectsActivityState(kind)
      if (isStateKind) {
        ctx.activity.report(taskId, kind, detail, tabId, session)
        if (explicitId && tabId) {
          await ctx.inbox
            .record(taskId, kind, detail, tabId)
            .catch((err) => logDaemonError("attention-inbox-record", err))
        }
      }
      ctx.engineEvents?.append(taskId, {
        kind,
        ...(tabId ? { tabId } : {}),
        ...(reportedVendor ? { vendor: reportedVendor } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(detail ? { detail } : {}),
        at: Date.now(),
      })
      if (kind === "pre-compact" || kind === "post-compact" || kind === "subagent-start" || kind === "subagent-stop") {
        ctx.bus.publish("engine.lifecycle", { taskId, kind, ...(tabId ? { tabId } : {}), at: Date.now() })
      }
      ctx.plugins?.handleEngineReport({
        kind,
        taskId,
        ...(detail ? { detail: detail as unknown as Record<string, unknown> } : {}),
        ...(reportedVendor ? { vendor: reportedVendor } : {}),
        ...(tabId ? { tabId } : {}),
        ...(sessionId ? { sessionId } : {}),
      })
      if (kind === "turn-start") {
        ctx.runtime
          .maybeAutoStart(ctx.orch, taskId)
          .then((result) => {
            if (result === "moved") console.log(`[status-rules] task ${taskId} auto-moved backlog → in_progress`)
          })
          .catch((err) => logDaemonError("status-rules", err))
        if (ctx.orch.getTask(taskId)?.quotaResume) {
          void ctx.orch.setQuotaResume(taskId, null).catch((err) => logDaemonError("quota-resume", err))
        }
      }
      if (kind === "turn-failed" && detail?.failure === "rate_limit") {
        void scheduleQuotaResume(ctx.orch, ctx.runtime, ctx.quotaUsage, taskId).catch((err) =>
          logDaemonError("quota-resume", err),
        )
      }
      return {}
    },
  },
]
