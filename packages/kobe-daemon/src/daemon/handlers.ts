/**
 * Daemon RPC handler registry.
 *
 * `server.ts`'s `dispatch` used to be one ~275-line switch over
 * {@link DaemonRequestName}: every case inlined payload extraction, error
 * wording, and the Orchestrator call, and the dispatch layer had zero tests.
 * Registry entries replace that switch: look up → validate → handle →
 * {@link shapeDaemonError}.
 *
 * Hard constraint: WIRE COMPATIBILITY. Every entry must produce
 * byte-equivalent success and error payloads to the pre-registry switch for
 * the same inputs — socket clients and the daemon web transport parse these
 * shapes. Success payload KEY ORDER is
 * load-bearing for byte equality (`JSON.stringify` preserves insertion
 * order), so handlers keep the exact literal shapes the switch returned,
 * `{}` returns included. Error message wording is part of the contract too
 * (`"${key} is required"`, `"unknown daemon request: …"`).
 *
 * One request is deliberately NOT here: `subscribe`. It is connection
 * lifecycle, not RPC — it mutates per-socket state (`subscribed`,
 * `holdsLifetime`), drives the gui-refcount idle-grace timer, and writes
 * event frames directly to the socket out-of-band (channel replay). The
 * registry's payload→result shape cannot express any of that, so it stays
 * special-cased in `server.ts` next to the machinery it manipulates.
 *
 * Everything a handler needs from the daemon process arrives via
 * {@link DaemonHandlerContext}, so a test can build the registry and dispatch
 * a request against a fake Orchestrator with NO socket involved (see
 * `packages/kobe/test/daemon/handlers.test.ts`).
 */

import type { DaemonRpcClient } from "../client/rpc.ts"
import type { DaemonActivityRegistry } from "./activity-registry.ts"
import type { AttentionInboxStore } from "./attention-inbox.ts"
import type { AutomationsStore } from "./automations-store.ts"
import type { DaemonOrchestrator } from "./contracts.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import { objectPayload, requireString } from "./handler-validators.ts"
import { ATTENTION_HANDLERS } from "./handlers-attention.ts"
import { AUTOMATION_HANDLERS } from "./handlers-automations.ts"
import { ENGINE_HANDLERS } from "./handlers-engine.ts"
import { TASK_HANDLERS } from "./handlers-task.ts"
import { UI_HANDLERS } from "./handlers-ui.ts"
import { WORK_ITEM_HANDLERS } from "./handlers-work-items.ts"
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
import type { QuotaUsageCache } from "./quota-usage-cache.ts"
import type { DaemonRuntimeAdapter } from "./runtime.ts"
import type { SessionBindingStore } from "./session-bindings.ts"
import type { TaskDeletionScheduler } from "./task-deletion-runner.ts"
import type { WorkItemCache } from "./work-items.ts"

// Re-exported for backward compatibility — `server.ts` and (transitively)
// `packages/kobe/test/daemon/handlers.test.ts` import these from here.
export {
  objectPayload,
  optionalActivityDetail,
  optionalBoolean,
  optionalString,
  optionalVendor,
  requireString,
} from "./handler-validators.ts"

/**
 * Everything a request handler may touch, threaded in by the caller per
 * dispatch. `server.ts` builds it from its closure; a test builds it from
 * fakes. Handlers themselves are stateless — ALL daemon state reaches them
 * through this context.
 */
export interface DaemonHandlerContext {
  /** Task-lifecycle owner — the single writer for the task index. */
  readonly orch: DaemonOrchestrator
  /** Product/runtime behavior supplied by the kobe composition root. */
  readonly runtime: DaemonRuntimeAdapter
  /** Push-channel hub (`task.setActive` publishes `active-task` here). */
  readonly bus: DaemonEventBus
  /** Transient engine-activity state (`engine.reportEvent`, `task.delete`). */
  readonly activity: DaemonActivityRegistry
  /** Durable attention episodes; independent from transient activity cleanup. */
  readonly inbox: AttentionInboxStore
  /** Durable Terminal Tab -> native engine-session identities. */
  readonly bindings: SessionBindingStore
  /** Starts deduplicated durable background deletion after RPC acceptance. */
  readonly deletions: TaskDeletionScheduler
  /** Daemon-owned issue tracker store, keyed by git common-dir. */
  readonly issues: IssuesStore
  /** Short-TTL cache over external tracker items (read-only view). */
  readonly workItems: WorkItemCache
  /** Daemon-owned scheduled automations + their run history. */
  readonly automations: AutomationsStore
  /** In-process RPC client for handlers that must drive the daemon's own
   *  request surface (the automation runner's engine launch). */
  readonly selfLink: DaemonRpcClient
  /** Rate-limited cache in front of the engine quota probes. */
  readonly quotaUsage: QuotaUsageCache
  /** Per-task recent engine events (`task.recentEvents`; absent in older tests). */
  readonly engineEvents?: import("./engine-events-log.ts").EngineEventLog
  /** Pending host-dialog prompts (`ui.prompt` / `ui.promptReply`). */
  readonly prompts?: import("./prompt-broker.ts").PromptBroker
  /** Plugin sink for agent-lifecycle events — a direct feed, deliberately NOT a bus channel. */
  readonly plugins?: Pick<import("../plugins/runtime.ts").PluginHost, "handleEngineReport" | "handleUiReport">
  /** Daemon-process facts + lifecycle controls handlers surface or drive. */
  readonly daemon: {
    readonly startedAt: Date
    readonly socketPath: string
    /** Loopback web transport port, when this daemon is exposing browser routes. */
    readonly webPort?: number
    /** Why the web transport isn't listening (port taken / bind failed), or
     *  null when it's up or was never requested. Reported by `daemon.status`
     *  so a socket-only degrade shows the real reason, not a generic error. */
    readonly webError?: string | null
    /** The daemon process pid (reported by `hello` / `daemon.status`). */
    readonly pid: number
    /** Attached-GUI refcount (reported as `attachedClients`). */
    guiCount(): number
    /** Graceful self-stop (`daemon.stop`). */
    stopSoon(): Promise<void>
    /** Re-check idle shutdown after a keep-alive hold may have been released
     *  (the last automation was disabled or deleted with no gui attached). */
    reevaluateIdle(): void
  }
  /** The requesting connection's id (`hello` echoes it back as `clientId`). */
  readonly clientId: number
}

/**
 * One registry entry — a self-contained RPC: payload validation (via the
 * shared `requireString`-family helpers) + the Orchestrator/daemon call.
 * Throwing is the error path; the caller shapes the thrown value with
 * {@link shapeDaemonError}. The returned value is the response frame's
 * `payload`, byte-for-byte.
 */
export interface DaemonRequestHandler {
  readonly name: DaemonRequestName
  /**
   * Browser-reachable through POST /api/rpc? Absent/false means socket-only.
   * This is the ONE place an RPC declares its web exposure — the web
   * transport derives its allowset from the registry (see
   * {@link webExposedRpcNames}), so a new verb is not browser-reachable
   * until its entry says so. Connection-scoped verbs (`hello`), the daemon
   * kill switch (`daemon.stop`), and hook-ingest paths must stay unexposed.
   */
  readonly web?: boolean
  handle(payload: Record<string, unknown>, ctx: DaemonHandlerContext): Promise<unknown> | unknown
}

/** The registry-derived web-RPC allowset: every entry marked `web: true`. */
export function webExposedRpcNames(
  registry: ReadonlyMap<DaemonRequestName, DaemonRequestHandler>,
): ReadonlySet<DaemonRequestName> {
  const names = new Set<DaemonRequestName>()
  for (const entry of registry.values()) if (entry.web === true) names.add(entry.name)
  return names
}

/**
 * The ONE place a thrown error becomes an on-the-wire {@link DaemonError}.
 * Matches the pre-registry shaping exactly: `Error` instances carry their
 * `message` + `name` (a plain `Error` serializes as `name: "Error"`);
 * anything else is `String(…)`-coerced with `name` omitted (`undefined`
 * is dropped by `JSON.stringify`, so the key never hits the wire).
 *
 * NOT used by `server.ts`'s parse-error path, which historically sends a
 * bare `{ message }` with no `name` key even for `Error`s — shaping it here
 * would add `"name":"SyntaxError"` bytes to the wire.
 */
export function shapeDaemonError(err: unknown): DaemonError {
  return {
    message: err instanceof Error ? err.message : String(err),
    name: err instanceof Error ? err.name : undefined,
  }
}

/**
 * Look up + run the handler for `name`. The unknown-request error keeps the
 * switch's `default` wording exactly — a v2 client's removed `daemon.web.*`
 * requests (and any future-client request) must keep getting the same
 * `unknown daemon request: …` message.
 */
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

/**
 * Build the registry. Handlers are stateless (state arrives via ctx), so the
 * map is safe to share across every connection of a server instance.
 */
export function createDaemonHandlerRegistry(): ReadonlyMap<DaemonRequestName, DaemonRequestHandler> {
  const entries: DaemonRequestHandler[] = [
    {
      name: "hello",
      handle(payload, ctx) {
        // Negotiate a compatibility RANGE (see protocol.ts isProtocolCompatible).
        // A client that omits a field is tolerated: a missing version means
        // "current", a missing min means "same as its version". Only a true
        // range mismatch is rejected, with a clear upgrade message.
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
          // The daemon's BUILD version (package.json). The protocol range above
          // only catches a breaking wire change; this lets the client detect a
          // stale-build daemon after a patch upgrade (same protocol, old code in
          // memory) and surface a non-fatal "restart the daemon" banner (KOB).
          kobeVersion: ctx.runtime.currentVersion,
          capabilities: [...CHANNEL_NAMES],
          daemonPid: ctx.daemon.pid,
          clientId: ctx.clientId,
          tasks: ctx.orch.listTasks().map(serializeTask),
        }
      },
    },
    {
      name: "daemon.status",
      web: true,
      handle(_payload, ctx) {
        return {
          daemonPid: ctx.daemon.pid,
          // Build version of the running daemon (package.json) — surfaced in
          // `daemon status` / `kobe doctor` so a stale-build daemon is visible
          // even without a TUI attached (KOB).
          kobeVersion: ctx.runtime.currentVersion,
          uptimeMs: Date.now() - ctx.daemon.startedAt.getTime(),
          startedAt: ctx.daemon.startedAt.toISOString(),
          // Attached GUIs (role "gui" front-ends) — the refcount that keeps
          // the daemon alive. Excludes in-tmux helper panes (role "pane") and
          // transient CLI pokes, so this reflects "humans looking at kobe".
          attachedClients: ctx.daemon.guiCount(),
          // Why this daemon may be up with zero attached clients. Without it,
          // a daemon staying alive for a schedule looks like a leak.
          automationHold: ctx.automations.hasEnabled(),
          taskCount: ctx.orch.listTasks().length,
          socketPath: ctx.daemon.socketPath,
          webPort: ctx.daemon.webPort ?? null,
          webError: ctx.daemon.webError ?? null,
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
    // `task.*` (+ `project.forget`) and `worktree.*` live in their own files
    // (handlers-task.ts / handlers-worktree.ts) — split out to stay under
    // the repo's 500-line file-size cap. Entry ORDER here doesn't affect any
    // individual response's byte shape (only within-object key order is
    // wire-load-bearing), so grouping them via spread is safe.
    ...TASK_HANDLERS,
    ...WORKTREE_HANDLERS,
    ...ATTENTION_HANDLERS,
    ...AUTOMATION_HANDLERS,
    ...WORK_ITEM_HANDLERS,
    ...UI_HANDLERS,
    ...ENGINE_HANDLERS,
    {
      name: "issue.list",
      async handle(payload, ctx) {
        return ctx.issues.list(requireString(payload, "repoRoot"))
      },
    },
    {
      name: "issue.mutate",
      async handle(payload, ctx) {
        const repoRoot = requireString(payload, "repoRoot")
        const state = await ctx.issues.mutate(repoRoot, payload.op)
        ctx.bus.publish("issue.snapshot", state)
        ctx.plugins?.handleUiReport({
          kind: "issue.changed",
          detail: {
            repo: repoRoot,
            ...(payload.op && typeof payload.op === "object" ? { op: payload.op as Record<string, unknown> } : {}),
          },
        })
        return state
      },
    },
    {
      name: "task.recentEvents",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        if (!ctx.orch.getTask(taskId)) throw new Error(`task not found: ${taskId}`)
        return { events: ctx.engineEvents?.recent(taskId) ?? [] }
      },
    },
  ]
  return new Map(entries.map((entry) => [entry.name, entry]))
}
