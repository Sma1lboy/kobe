/**
 * Daemon wire protocol (v0.6).
 *
 * v0.5's protocol was huge because the daemon hosted live chat
 * streams: `chat.delta`, `chat.event`, `chat.complete`, pending-input
 * brokers, plan-usage polling, rc-bridge state, etc. v0.6 collapses
 * all of that — claude lives in tmux, so the daemon's only job is to
 * be a single writer for the task index. The protocol shrinks to a
 * task-CRUD + subscribe shape.
 */

import type { EngineActivityDetail, TaskActivityState } from "../engine/hook-events.ts"
import type { Task } from "../types/task.ts"
import type { UpdateInfo } from "../version.ts"

/**
 * Bumped to 2 in v0.6 to signal the shape change. The handshake now
 * negotiates a COMPATIBILITY RANGE rather than requiring an exact match
 * (LSP-style): each peer advertises its current version plus the oldest
 * version it can still talk to ({@link MIN_COMPATIBLE_PROTOCOL_VERSION}),
 * and unknown extra fields are ignored. A backward-compatible change bumps
 * `DAEMON_PROTOCOL_VERSION` while leaving `MIN_COMPATIBLE_PROTOCOL_VERSION`
 * put, so a newer daemon keeps serving a slightly-older TUI through a
 * rolling upgrade instead of hard-rejecting it. Bump the MIN only on a
 * breaking change.
 */
export const DAEMON_PROTOCOL_VERSION = 2

/** Oldest protocol version this build can still interoperate with. */
export const MIN_COMPATIBLE_PROTOCOL_VERSION = 2

/**
 * Two protocol peers are compatible iff EACH side's current version is at
 * least the OTHER side's minimum-supported version. Symmetric; unknown
 * extra hello fields are ignored by the caller. Pure — unit-tested.
 */
export function isProtocolCompatible(args: {
  readonly localVersion: number
  readonly localMin: number
  readonly remoteVersion: number
  readonly remoteMin: number
}): boolean {
  return args.remoteVersion >= args.localMin && args.localVersion >= args.remoteMin
}

/**
 * Build-version skew check (KOB) — distinct from the protocol check above.
 * The protocol range only catches a BREAKING wire change; a normal patch
 * upgrade keeps the same protocol version, so a stale-build daemon (the user
 * upgraded the binary but the long-lived daemon is still running the old code
 * in memory) is otherwise invisible. This compares the daemon's reported build
 * version (`hello.kobeVersion` / `daemon.status`'s `kobeVersion`) against the
 * client's own {@link import("../version").CURRENT_VERSION}.
 *
 * NON-FATAL by design: a mismatch means "the code is stale, restart it", not
 * "these two can't talk" — so this only drives a dismissible banner, never a
 * thrown error. Returns `false` when the daemon's version is unknown (an older
 * daemon that predates this field omits it), so an old daemon never produces a
 * false "stale" signal — it just goes unflagged.
 *
 * Pure — unit-tested. A plain string inequality (not semver) is intentional:
 * any difference at all — newer OR older daemon — is worth a restart prompt,
 * and the build versions are the package.json strings on both sides.
 */
export function isDaemonVersionStale(daemonVersion: string | undefined, clientVersion: string): boolean {
  if (!daemonVersion) return false
  return daemonVersion !== clientVersion
}

export type DaemonFrame =
  | { readonly type: "request"; readonly id: string; readonly name: DaemonRequestName; readonly payload?: unknown }
  | {
      readonly type: "response"
      readonly id: string
      readonly name?: string
      readonly payload?: unknown
      readonly error?: DaemonError
    }
  | { readonly type: "event"; readonly name: DaemonEventName; readonly payload: unknown }

export type DaemonRequestName =
  | "hello"
  | "daemon.status"
  | "daemon.stop"
  | "subscribe"
  | "task.list"
  | "task.get"
  | "task.create"
  | "task.archive"
  | "task.rename"
  | "task.setBranch"
  | "task.setVendor"
  | "task.delete"
  | "task.pin"
  | "task.status"
  | "task.ensureMain"
  | "task.ensureWorktree"
  | "task.setActive"
  | "worktree.discoverAdoptable"
  | "worktree.adopt"
  // Engine HOOK ingest (KOB): a `kobe hook <verb>` process reports a
  // normalized engine activity event for a task; the daemon folds it into
  // the task's transient activity state and broadcasts `engine-state`.
  | "engine.reportEvent"

/**
 * Subscribe role (KOB) — distinguishes WHO is subscribing, so the daemon's
 * refcounted lazy-shutdown counts only real front-end attaches.
 *
 * - `gui`  — a user-facing front-end attach (the `kobe` process parked on
 *   `tmux attach`, or the deprecated outer monitor). Its lifetime equals
 *   "a human is looking at kobe", so it HOLDS the daemon alive.
 * - `pane` — a kobe-spawned helper inside the tmux session (Tasks pane, Ops,
 *   settings/new-task windows, transient `kobe api` pokes). It subscribes to
 *   RECEIVE push channels but must NOT keep the daemon alive: these panes
 *   outlive the attach (the tmux session persists after the user quits), so
 *   counting them wedged the daemon open forever — N ChatTab windows meant N
 *   Tasks panes, so the count never reached 0 on quit.
 *
 * Default is `pane`: a subscriber that forgets to declare a role is the safe
 * non-holding kind, so a future client can never accidentally pin the daemon.
 */
export type SubscribeRole = "gui" | "pane"

/**
 * Channel registry — the SINGLE source of truth for daemon→client push
 * channels (KOB-246). The daemon is a cross-process pub/sub bus over the
 * socket: each channel carries a last-value the daemon caches and replays
 * to a late subscriber on connect (see `daemon/event-bus.ts`). Add a key
 * here (name + payload type) and the whole stack — `bus.publish`,
 * `client.onChannel`, the subscribe-time replay — is typed for it; nothing
 * else needs touching.
 *
 * Ordering: per-socket delivery is FIFO; cross-channel ordering is NOT
 * guaranteed. Last-value replay suits STATE channels (a snapshot, a cost,
 * a status); a true event-LOG channel would only replay its last item.
 */
export interface ChannelPayloads {
  "task.snapshot": { tasks: SerializedTask[] }
  /**
   * The currently-active task (the session last switched/entered into).
   * Shared so EVERY Tasks pane + the outer monitor highlight the SAME
   * focus, instead of each pane remembering its own last click (KOB-247).
   * `null` = nothing active yet. Set via the `task.setActive` RPC.
   */
  "active-task": { taskId: string | null }
  /**
   * Latest published-version info, polled by the daemon on an interval and
   * pushed to every pane so each `kobe tasks` process doesn't hit the npm
   * registry itself (KOB — daemon-owned update check). `info` is `null`
   * when the check is suppressed (dev mode) or unavailable (offline).
   */
  update: { info: UpdateInfo | null }
  /**
   * Transient, engine-driven activity for ONE task — pushed when a hook
   * event arrives (KOB). Distinct from `task.snapshot`'s lifecycle status:
   * this is "what is the engine doing right now" (running / turn just
   * completed / rate-limited / waiting on a permission prompt), reduced from
   * normalized hook verbs ({@link import("../engine/hook-events").reduceActivity}).
   * Last-value-per-channel replay means a late subscriber gets the most
   * recent task's state; the daemon also lets a state lapse back to idle.
   */
  "engine-state": { taskId: string; state: TaskActivityState; detail?: EngineActivityDetail; at: number }
  // Add a channel ↓ then `bus.publish(name, payload)` in the daemon and
  // `client.onChannel(name, …)` in a consumer — that's the whole recipe:
  // "cost": { taskId: string; usd: number; tokens: number }
  // "pr-status": { taskId: string; state: "open" | "merged" | "closed" | "none" }
}

/** A push-channel name (a key of {@link ChannelPayloads}). */
export type ChannelName = keyof ChannelPayloads

/** Runtime channel list — defaults subscribe-to-all + validates a filter. */
export const CHANNEL_NAMES: readonly ChannelName[] = ["task.snapshot", "active-task", "update", "engine-state"]

/**
 * Event-frame names: every {@link ChannelName}, plus `daemon.stopping` — a
 * lifecycle signal that is deliberately NOT a channel (it has no last-value
 * and must never be replayed to a late subscriber as if current).
 */
export type DaemonEventName = ChannelName | "daemon.stopping"

export interface DaemonError {
  readonly message: string
  readonly name?: string
}

export interface SerializedTask {
  readonly id: string
  readonly title: string
  readonly repo: string
  readonly branch: string
  readonly worktreePath: string
  readonly kind: "main" | "task"
  readonly status: Task["status"]
  readonly archived: boolean
  readonly pinned: boolean
  readonly vendor?: Task["vendor"]
  readonly prStatus?: Task["prStatus"]
  readonly createdAt: string
  readonly updatedAt: string
}

export function serializeTask(task: Task): SerializedTask {
  return {
    id: task.id,
    title: task.title,
    repo: task.repo,
    branch: task.branch,
    worktreePath: task.worktreePath,
    kind: task.kind ?? "task",
    status: task.status,
    archived: task.archived,
    pinned: task.pinned ?? false,
    vendor: task.vendor,
    prStatus: task.prStatus,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export function frameToLine(frame: DaemonFrame): string {
  return `${JSON.stringify(frame)}\n`
}
