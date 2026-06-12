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
 * the same inputs — clients parse these shapes (and `kobe-web/server` speaks
 * the same protocol as a socket client). Success payload KEY ORDER is
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

import { type EngineActivityDetail, isEngineActivityKind } from "@/engine/hook-events"
import type { Orchestrator } from "@/orchestrator/core"
import type { VendorId } from "@/types/task"
import { CURRENT_VERSION } from "@/version"
import type { DaemonActivityRegistry } from "./activity-registry.ts"
import { logDaemonError } from "./crash-log.ts"
import { findAdoptableWorktree, matchRepoByCwd, matchTaskByCwd } from "./cwd-task.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import {
  CHANNEL_NAMES,
  DAEMON_PROTOCOL_VERSION,
  type DaemonError,
  type DaemonRequestName,
  MIN_COMPATIBLE_PROTOCOL_VERSION,
  isProtocolCompatible,
  serializeTask,
} from "./protocol.ts"

/**
 * Everything a request handler may touch, threaded in by the caller per
 * dispatch. `server.ts` builds it from its closure; a test builds it from
 * fakes. Handlers themselves are stateless — ALL daemon state reaches them
 * through this context.
 */
export interface DaemonHandlerContext {
  /** Task-lifecycle owner — the single writer for the task index. */
  readonly orch: Orchestrator
  /** Push-channel hub (`task.setActive` publishes `active-task` here). */
  readonly bus: DaemonEventBus
  /** Transient engine-activity state (`engine.reportEvent`, `task.delete`). */
  readonly activity: DaemonActivityRegistry
  /** Daemon-process facts + lifecycle controls handlers surface or drive. */
  readonly daemon: {
    readonly startedAt: Date
    readonly socketPath: string
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
  handle(payload: Record<string, unknown>, ctx: DaemonHandlerContext): Promise<unknown> | unknown
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
          // Build version of the running daemon (package.json) — surfaced in
          // `daemon status` / `kobe doctor` so a stale-build daemon is visible
          // even without a TUI attached (KOB).
          kobeVersion: CURRENT_VERSION,
          uptimeMs: Date.now() - ctx.daemon.startedAt.getTime(),
          startedAt: ctx.daemon.startedAt.toISOString(),
          // Attached GUIs (role "gui" front-ends) — the refcount that keeps
          // the daemon alive. Excludes in-tmux helper panes (role "pane") and
          // transient CLI pokes, so this reflects "humans looking at kobe".
          attachedClients: ctx.daemon.guiCount(),
          taskCount: ctx.orch.listTasks().length,
          socketPath: ctx.daemon.socketPath,
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
    {
      name: "task.list",
      handle(_payload, ctx) {
        return { tasks: ctx.orch.listTasks().map(serializeTask) }
      },
    },
    {
      name: "task.get",
      handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        const task = ctx.orch.getTask(taskId)
        if (!task) throw new Error(`task not found: ${taskId}`)
        return { task: serializeTask(task) }
      },
    },
    {
      name: "task.create",
      async handle(payload, ctx) {
        const repo = requireString(payload, "repo")
        const task = await ctx.orch.createTask({
          repo,
          title: optionalString(payload, "title"),
          branch: optionalString(payload, "branch"),
          baseRef: optionalString(payload, "baseRef"),
          vendor: optionalVendor(payload, "vendor"),
        })
        return { taskId: task.id, task: serializeTask(task) }
      },
    },
    {
      name: "task.archive",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        await ctx.orch.setArchived(taskId, optionalBoolean(payload, "archived"))
        return {}
      },
    },
    {
      name: "task.rename",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        await ctx.orch.setTitle(taskId, requireString(payload, "title"))
        return {}
      },
    },
    {
      name: "task.setBranch",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        await ctx.orch.setBranch(taskId, requireString(payload, "branch"))
        return {}
      },
    },
    {
      name: "task.setVendor",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        const vendor = optionalVendor(payload, "vendor")
        if (!vendor) throw new Error("task.setVendor: vendor is required")
        await ctx.orch.setVendor(taskId, vendor)
        return {}
      },
    },
    {
      name: "task.delete",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        await ctx.orch.deleteTask(taskId, { force: optionalBoolean(payload, "force") })
        ctx.activity.clearTask(taskId)
        return {}
      },
    },
    {
      name: "task.pin",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        await ctx.orch.setPinned(taskId, optionalBoolean(payload, "pinned"))
        return {}
      },
    },
    {
      name: "task.move",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        const direction = requireString(payload, "direction")
        if (direction !== "up" && direction !== "down") throw new Error("direction must be up or down")
        await ctx.orch.moveTask(taskId, direction === "up" ? -1 : 1)
        return {}
      },
    },
    {
      name: "task.status",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        const status = requireString(payload, "status")
        if (
          status !== "backlog" &&
          status !== "in_progress" &&
          status !== "in_review" &&
          status !== "done" &&
          status !== "canceled" &&
          status !== "error"
        ) {
          throw new Error("status must be a TaskStatus")
        }
        await ctx.orch.setStatus(taskId, status)
        return {}
      },
    },
    {
      name: "task.reorder",
      async handle(payload, ctx) {
        const moves = payload.moves
        if (!Array.isArray(moves) || moves.length === 0) throw new Error("moves must be a non-empty array")
        if (moves.length > 500) throw new Error("too many moves in one task.reorder batch (max 500)")
        const parsed = moves.map((move) => {
          if (typeof move !== "object" || move === null) throw new Error("each move needs taskId and position")
          const entry = move as Record<string, unknown>
          const taskId = requireString(entry, "taskId")
          const position = entry.position
          if (typeof position !== "number" || !Number.isFinite(position)) {
            throw new Error("position must be a finite number")
          }
          return { taskId, position }
        })
        await ctx.orch.reorderTasks(parsed)
        return {}
      },
    },
    {
      name: "task.ensureMain",
      async handle(payload, ctx) {
        const repo = requireString(payload, "repo")
        const task = await ctx.orch.ensureMainTask(repo)
        return { task: serializeTask(task) }
      },
    },
    {
      name: "task.ensureWorktree",
      async handle(payload, ctx) {
        const taskId = requireString(payload, "taskId")
        // Long-operation feedback (issue #5): `git worktree add` is
        // minute-class on a huge repo, and the RPC stays BLOCKING (callers
        // need the path to build the tmux session) — so publish lifecycle
        // progress on the `task.jobs` channel around the call. Every
        // attached Tasks pane shows a "materializing" row state, not just
        // the initiating client. A terminal phase (`done`/`error`) is
        // published ALWAYS, including on throw — otherwise the bus's
        // last-value replay would show late subscribers a stuck `running`
        // forever. Fast paths (already-materialised worktree, `main`
        // tasks) publish running→done back-to-back, which clients fold
        // into a no-op blink at worst. The error message rides along for
        // UI hints; the RPC error itself still reaches the caller via the
        // rethrow.
        ctx.bus.publish("task.jobs", { taskId, kind: "ensureWorktree", phase: "running" })
        try {
          const path = await ctx.orch.ensureWorktree(taskId)
          ctx.bus.publish("task.jobs", { taskId, kind: "ensureWorktree", phase: "done" })
          return { worktreePath: path }
        } catch (err) {
          ctx.bus.publish("task.jobs", {
            taskId,
            kind: "ensureWorktree",
            phase: "error",
            error: err instanceof Error ? err.message : String(err),
          })
          throw err
        }
      },
    },
    {
      name: "worktree.discoverAdoptable",
      async handle(payload, ctx) {
        const repo = requireString(payload, "repo")
        const worktrees = await ctx.orch.discoverAdoptableWorktrees(repo)
        return { worktrees }
      },
    },
    {
      name: "worktree.adopt",
      async handle(payload, ctx) {
        const task = await ctx.orch.adoptWorktree({
          repo: requireString(payload, "repo"),
          worktreePath: requireString(payload, "worktreePath"),
          branch: optionalString(payload, "branch"),
          vendor: optionalVendor(payload, "vendor"),
          title: optionalString(payload, "title"),
          ifExists: optionalString(payload, "ifExists") === "return" ? "return" : "error",
        })
        return { task: serializeTask(task) }
      },
    },
    {
      name: "worktree.reconcile",
      async handle(payload, ctx) {
        // A `kobe hook worktree-created` (global PostToolUse) reporting that a
        // `git worktree add` just ran in `cwd`, creating `worktreePath`. Adopt
        // it the MOMENT it's created — no engine session needed (the
        // creation-time complement to the `session-start` auto-adopt in
        // `engine.reportEvent` below). Bounded to repos kobe already tracks
        // (so a stray worktree in an untracked repo is ignored); `adoptWorktree`
        // is idempotent + git-validated, so a re-fired hook or a bogus path is a
        // harmless no-op (the path just fails validation → caught → dropped).
        const cwd = requireString(payload, "cwd")
        const worktreePath = requireString(payload, "worktreePath")
        const repo = matchRepoByCwd(ctx.orch.listTasks(), cwd) ?? matchRepoByCwd(ctx.orch.listTasks(), worktreePath)
        if (!repo) return { adopted: false }
        try {
          const task = await ctx.orch.adoptWorktree({ repo, worktreePath, ifExists: "return" })
          return { adopted: true, taskId: task.id }
        } catch (err) {
          logDaemonError("worktree-created", err)
          return { adopted: false }
        }
      },
    },
    {
      name: "task.setActive",
      async handle(payload, ctx) {
        // UI/session focus lives on the bus, but setting it also touches the
        // task's updatedAt so "recent" task sorting reflects actual use.
        // Publishing caches the last value so a late-subscribing Tasks pane
        // gets the current focus on connect and every pane highlights the
        // same active task (KOB-247).
        const taskId = optionalString(payload, "taskId") ?? null
        await ctx.orch.setActiveTask(taskId)
        ctx.bus.publish("active-task", { taskId })
        return {}
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
        if (!isEngineActivityKind(kind)) throw new Error(`unknown engine event kind: ${kind}`)
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
        return {}
      },
    },
  ]
  return new Map(entries.map((entry) => [entry.name, entry]))
}

// ---------------------------------------------------------------------------
// Payload validators — the shared vocabulary every entry validates with.
// Promoted verbatim from server.ts's switch; the error wording
// (`"${key} is required"`, `"${key} must be a string"`, …) is part of the
// wire contract, so don't reword it.
// ---------------------------------------------------------------------------

/** Coerce an unknown request payload into a plain object (`{}` for anything else). */
export function objectPayload(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {}
  return payload as Record<string, unknown>
}

export function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`)
  return value
}

export function optionalString(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key]
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error(`${key} must be a string`)
  return value
}

export function optionalBoolean(payload: Record<string, unknown>, key: string): boolean | undefined {
  const value = payload[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`)
  return value
}

export function optionalVendor(payload: Record<string, unknown>, key: string): VendorId | undefined {
  // Engines are open: a vendor id may be a built-in OR a user-registered
  // custom engine (its launch command lives in the kobe-side customEngineIds
  // registry, which the daemon can't see). So accept any non-empty string and
  // let the launch path resolve it — a bogus id just fails to launch its
  // (missing) binary in the pane. Empty/absent stays undefined (→ claude).
  const value = optionalString(payload, key)
  return value && value.trim().length > 0 ? (value as VendorId) : undefined
}

/** Coerce the optional `detail` of an `engine.reportEvent` payload, dropping
 *  anything malformed (the field is best-effort UI hint, never load-bearing). */
export function optionalActivityDetail(payload: Record<string, unknown>): EngineActivityDetail | undefined {
  const raw = payload.detail
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined
  const d = raw as Record<string, unknown>
  const out: { failure?: "rate_limit" | "billing" | "other"; waiting?: "permission" | "input"; note?: string } = {}
  if (d.failure === "rate_limit" || d.failure === "billing" || d.failure === "other") out.failure = d.failure
  if (d.waiting === "permission" || d.waiting === "input") out.waiting = d.waiting
  if (typeof d.note === "string") out.note = d.note
  return Object.keys(out).length > 0 ? out : undefined
}
