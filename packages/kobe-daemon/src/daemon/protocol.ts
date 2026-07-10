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

import type { ChannelName } from "./channels.ts"
import type { DaemonTask } from "./contracts.ts"

export {
  CHANNEL_NAMES,
  type ChannelName,
  type ChannelPayloads,
  type SessionDeliverPayload,
  type TranscriptActivityPayload,
  type UiPrefsPayload,
  type WorktreeChangesPayload,
  isChannelName,
  normalizeChannelFilter,
} from "./channels.ts"

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
 *
 * v3: `daemon.web.start` / `daemon.web.stop` removed from the socket protocol.
 * Browser HTTP/SSE now lives on the daemon-owned web transport instead of a
 * socket RPC that starts/stops routes. A v2 client's `kobe web` gets a clear
 * "unknown daemon request" error; everything else still interoperates, so MIN
 * stays 2.
 *
 * v4: daemon-hosted PTYs (`pty.*` requests + targeted `pty.data`/`pty.exit`
 * event frames). Additive — an older client never sends `pty.*`, a newer
 * client against an older daemon gets "unknown daemon request" and falls back
 * to a local PTY — so MIN stays 2.
 */
export const DAEMON_PROTOCOL_VERSION = 4

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
  | "task.move"
  | "task.status"
  // Web-board ordering (docs/design/web-kanban.md M3): batch-assign sparse
  // fractional `position` keys for per-status column order. ONE snapshot
  // push per batch; the TUI never reads `position`.
  | "task.reorder"
  | "task.ensureMain"
  | "project.forget"
  | "task.ensureWorktree"
  | "task.setActive"
  | "issue.list"
  | "issue.mutate"
  | "worktree.discoverAdoptable"
  | "worktree.adopt"
  // Creation-time auto-adopt (KOB): a `kobe hook worktree-created` (global
  // PostToolUse) reports that a `git worktree add` just ran in `cwd`. The
  // daemon adopts the new worktree as a task the MOMENT it's created — no
  // engine session needed (the complement to session-start auto-adopt).
  | "worktree.reconcile"
  // Removal-time auto-archive (KOB): the same `kobe hook worktree-created`
  // (global PostToolUse) reports that a `git worktree remove <path>` just ran.
  // The daemon archives the task whose worktree was that path — the symmetric
  // complement to `worktree.reconcile` (remove a worktree → its task archives).
  | "worktree.archiveRemoved"
  // Cross-project worktree audit (the standalone worktree-management TUI
  // page): list every worktree of every local saved project (kobe-managed
  // or not, linked to a task or not) with dirty/age/remote-branch status,
  // and remove one (refuses a dirty worktree unless `force: true`, same
  // safety property `GitWorktreeManager.remove` always had).
  | "worktree.list"
  | "worktree.remove"
  // Engine HOOK ingest (KOB): a `kobe hook <verb>` process reports a
  // normalized engine activity event for a task; the daemon folds it into
  // the task's transient activity state and broadcasts `engine-state`.
  | "engine.reportEvent"
  // Dispatcher messenger (docs/design/dispatcher.md): publish a
  // `session.deliver` channel event addressed to a task's live session.
  // The daemon only routes; the front-end hosting that session delivers.
  | "session.deliver"
  // Field note (docs/design/dispatcher.md): a worktree session files a
  // one-line resolved gotcha; the daemon forwards it to the repo's
  // dispatcher seat (the main session) over `session.deliver`.
  | "note.file"
  // Hosted PTYs (v4) — the tmux-persistence replacement for the embedded
  // terminal. Served by the standalone PTY HOST process (`kobe pty-host`,
  // its own socket — see `pty-server.ts`), NOT by the daemon: the daemon
  // restarts routinely, the pty host must outlive it like the tmux server
  // did. Same frame grammar, so the same client class speaks both. The
  // host owns the raw PTY child + a byte ring buffer per session key; the
  // TUI keeps VT emulation (xterm-headless) local. `pty.open` attaches
  // the calling CONNECTION (spawning on first open, replaying the ring
  // buffer on reattach); output streams back as targeted `pty.data` event
  // frames written only to attached connections. `pty.sweep` is the
  // daemon→host janitor call: kill sessions whose task got archived.
  | "pty.open"
  | "pty.write"
  | "pty.resize"
  | "pty.kill"
  | "pty.detach"
  | "pty.list"
  | "pty.sweep"

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
 * Event-frame names: every {@link ChannelName}, plus `daemon.stopping` — a
 * lifecycle signal that is deliberately NOT a channel (it has no last-value
 * and must never be replayed to a late subscriber as if current) — plus the
 * targeted PTY stream frames (`pty.data` / `pty.exit`, v4). PTY frames are
 * also NOT channels: they are written only to connections attached to that
 * PTY session, carry an ordered byte stream (dropping or replaying one
 * corrupts the client's VT state), and never pass through the event bus.
 */
export type DaemonEventName = ChannelName | "daemon.stopping" | "pty.data" | "pty.exit"

/** Targeted `pty.data` event payload — one ordered chunk of PTY output. */
export interface PtyDataEventPayload {
  /** The PTY session key (the TUI's registry key, e.g. `taskId::tabId`). */
  readonly key: string
  /** Raw child output bytes, base64-encoded (JSON-lines wire). */
  readonly data: string
}

/** Targeted `pty.exit` event payload — the session's child ended. */
export interface PtyExitEventPayload {
  readonly key: string
  /** The dead child's pid (null when spawn failed). Lets a client that
   *  kill()ed + reopened the same key tell the OLD incarnation's exit
   *  apart from its new session's — absent from pre-pid hosts. */
  readonly pid?: number | null
}

/** `pty.open` response — attach result for one session key. */
export interface PtyOpenResult {
  /** Ring-buffer replay (base64) — everything the child wrote, capped. */
  readonly replay: string
  /** False when the session exists but its child already exited. */
  readonly alive: boolean
  /** This session's child pid (null when spawn failed) — the client keys
   *  `pty.exit` frames against it; absent from pre-pid hosts. */
  readonly pid?: number | null
}

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
  readonly status: DaemonTask["status"]
  readonly archived: boolean
  readonly pinned: boolean
  readonly vendor?: DaemonTask["vendor"]
  readonly prStatus?: DaemonTask["prStatus"]
  /** Web-board ordering key (sparse fractional; absent until first drop). */
  readonly position?: number
  /** Engine reasoning/effort level, when the vendor supports one. */
  readonly modelEffort?: string
  readonly createdAt: string
  readonly updatedAt: string
}

export function serializeTask(task: DaemonTask): SerializedTask {
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
    position: task.position,
    modelEffort: task.modelEffort,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export function frameToLine(frame: DaemonFrame): string {
  return `${JSON.stringify(frame)}\n`
}
