/**
 * Daemon RPC handler registry.
 *
 * `server.ts`'s `dispatch` used to be one ~275-line switch over
 * {@link DaemonRequestName}: every case inlined payload extraction, error
 * wording, and the Orchestrator call, and the dispatch layer had zero tests.
 * This module breaks the switch into self-contained entries —
 * `{ name, handle(payload, ctx) }` — keyed in a registry map, so the dispatch
 * seam is: look up entry → validate (the same `requireString`-family helpers,
 * now shared here) → handle → uniform error shaping
 * ({@link shapeDaemonError}, the ONE place a thrown error becomes a
 * {@link DaemonError}).
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

import type { DaemonActivityRegistry } from "./activity-registry.ts"
import type { DaemonOrchestrator } from "./contracts.ts"
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
import type { DaemonRuntimeAdapter } from "./runtime.ts"

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
  /** Daemon-owned issue tracker store, keyed by git common-dir. */
  readonly issues: IssuesStore
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
        // Dispatcher messenger (docs/design/dispatcher.md): `kobe api
        // dispatch` routes text to a task's live engine session. The daemon
        // only validates + broadcasts; the front-end hosting that session
        // (the SPA via /pty/send) owns the actual paste.
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
        // Field note (docs/design/dispatcher.md): a worktree session files a
        // one-line resolved gotcha. The daemon's only intelligence is
        // ADDRESSING — find the author's repo's dispatcher seat (the main
        // session) and forward over session.deliver with provenance. WHO
        // benefits from the note is the dispatcher agent's judgment, not
        // daemon code.
        const taskId = requireString(payload, "taskId")
        const text = requireString(payload, "text")
        const author = ctx.orch.getTask(taskId)
        if (!author) throw new Error(`task not found: ${taskId}`)
        const main = ctx.orch
          .listTasks()
          .find((t) => (t.kind ?? "task") === "main" && t.repo === author.repo && !t.archived)
        // No dispatcher seat, or the dispatcher noting to itself: accepted
        // but unrouted — filing must never error a working agent.
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
        // A `kobe hook <verb>` process reporting a NORMALIZED engine activity
        // event (the vendor-specific hook was already translated by the
        // engine's hook adapter). The global hooks carry no task id — they
        // report their `cwd`, which we map to a task by worktree path. Fold it
        // into the task's transient activity state + broadcast on
        // `engine-state`. Unknown kinds are ignored (forward-compat: a newer
        // adapter, older daemon); an unmatched cwd (an unrelated repo, a
        // project with no kobe task) is silently dropped.
        const kind = requireString(payload, "kind")
        if (!ctx.runtime.isEngineActivityKind(kind)) throw new Error(`unknown engine event kind: ${kind}`)
        // `taskId` (legacy/direct) wins; otherwise resolve from `cwd`.
        const explicitId = optionalString(payload, "taskId")
        const cwd = optionalString(payload, "cwd")
        // External-worktree sync (replaces the removed WorktreeCreate hook): a
        // session starting in an unadopted worktree under a tracked repo's
        // a managed worktree root is auto-adopted as a task, so the cwd then maps
        // to it below. Gated to `session-start` to bound the work; the path
        // check is git-free and `adoptWorktree` is idempotent + git-validated
        // (a bogus dir just throws → caught → dropped).
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
        if (!taskId) return {} // unmatched cwd → drop
        const detail = optionalActivityDetail(payload)
        ctx.activity.report(taskId, kind, detail)
        // Auto status flow (docs/design/web-kanban.md M5): an engine
        // STARTING a turn on a backlog task means work began — a pure rule
        // advances it to in_progress. (in_progress → in_review is the
        // agent's own self-report via the injected status protocol, not a
        // daemon rule.) Fire-and-forget; gated inside maybeAutoStart
        // (opt-in state.json flag).
        if (kind === "turn-start") {
          ctx.runtime
            .maybeAutoStart(ctx.orch, taskId)
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
