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

import type { EngineActivityDetail, TaskActivityState } from "@/engine/hook-events"
import type { Task } from "@/types/task"
import type { UpdateInfo } from "@/version"
import type { RepoIssues } from "./issues-store.ts"

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
 * v3: `daemon.web.start` / `daemon.web.stop` removed — the web UI's server
 * moved out of the daemon into a standalone bridge (kobe-web/server) that
 * speaks this protocol as a regular `role: "gui"` subscriber. A v2 client's
 * `kobe web` gets a clear "unknown daemon request" error; everything else
 * still interoperates, so MIN stays 2.
 */
export const DAEMON_PROTOCOL_VERSION = 3

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
   * Daemon-owned issue tracker snapshot for ONE repo. Published after every
   * `issue.mutate`, so every attached web Issues pane updates from the same
   * source of truth whether the edit came from web, TUI, or `kobe api`.
   * The payload is the repo's full issue state, not a delta, matching the
   * `/api/issues` route and keeping clients stateless. Last-value replay only
   * carries the most recently changed repo; browsers still do their normal
   * initial `/api/issues` load for every visible repo, then use this channel
   * for live updates.
   */
  "issue.snapshot": RepoIssues
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
  /**
   * The user's persisted VISUAL prefs (`state.json`'s `activeTheme` /
   * `transparentBackground` / `focusAccent` / `activeSortMode`), pushed
   * whenever the daemon's file watcher sees them change. Every pane host
   * applies the payload live so a theme switch in one session's Settings
   * restyles the Tasks/Ops panes of EVERY task session — without this, each
   * pane read the prefs once at boot and kept the old look forever. The
   * same fan-out carries `sortMode`: toggling the Tasks-pane sort (`t`) in
   * one session re-sorts the Tasks pane of EVERY session, instead of only
   * the pane the key was pressed in; `keysCollapsed` likewise syncs the
   * Tasks-pane `── keys ──` legend fold (`?`) across every session. Last-
   * value replay hydrates a late/reconnecting subscriber. `focusAccent` is
   * the raw slot string (`null` = unset → the default slot); the TUI side
   * validates it — the daemon stays vendor/UI-neutral and just mirrors the
   * file.
   */
  "ui-prefs": {
    theme: string
    transparentBackground: boolean
    focusAccent: string | null
    sortMode: "default" | "recent"
    keysCollapsed: boolean
  }
  /**
   * "Re-read your keybindings" ping (KOB — live keybinding propagation).
   * The daemon's keybindings-file watcher bumps `rev` whenever
   * `~/.kobe/settings/keybindings.yaml` changes; every pane re-reads +
   * re-applies the file onto its in-memory `KobeKeymap` (and re-renders the
   * chord legends), so an edit takes effect across EVERY session without a
   * rebuild. The daemon carries no keymap data — `rev` is an opaque change
   * token; only its TRANSITIONS matter. Last-value replay lets a late
   * subscriber learn the channel's current rev (it skips the first value so
   * a fresh pane doesn't re-apply what it already read at boot).
   */
  keybindings: { rev: number }
  /**
   * Lifecycle progress of a MINUTE-CLASS daemon operation on one task
   * (today: `task.ensureWorktree` — `git worktree add` on a huge repo).
   * The blocking RPC contract is untouched (callers still await the
   * result); this channel is the additive feedback path, so EVERY
   * attached Tasks pane — not just the initiator — can show a live
   * "materializing" state on the task row while the job runs.
   *
   * The publisher MUST always emit a terminal phase (`done` / `error`),
   * including on throw — the handler wraps the operation in try/catch.
   * Replay of a terminal phase to a late subscriber is harmless by
   * design: clients treat `done`/`error` as "remove the entry", a no-op
   * when nothing is tracked. A replayed `running` is only possible while
   * the op is GENUINELY in flight (the bus is in-memory and dies with
   * the daemon), so a late pane correctly picks up an ongoing job.
   * Last-value caveat: with two jobs overlapping, a late subscriber only
   * replays the most recent publish — live subscribers see both.
   */
  "task.jobs": {
    taskId: string
    kind: "ensureWorktree"
    phase: "running" | "done" | "error"
    /** Present only on `phase: "error"` — the thrown message, for UI hints. */
    error?: string
  }
  /**
   * Uncommitted-change counts for every collected worktree (issue #6) —
   * the daemon is the SINGLE `git status` collector; panes render these
   * pushes instead of each running their own per-row git polls (N panes ×
   * M tasks of duplicated subprocesses, the pre-daemon shape). The payload
   * is the FULL map (worktreePath → counts), republished only when
   * something actually changed, so the last-value replay hands a late
   * subscriber the whole picture in one frame. Keys are absolute LOCAL
   * worktree paths; archived tasks and remote (`ssh://`) projects are
   * never collected, and a deleted/archived task's entry drops from the
   * map on the collector's next tick. A `Record` (not a Map) because this
   * is a JSON wire payload. Clients that never see this channel (an older
   * daemon — detected via `hello.capabilities`) fall back to local
   * polling.
   */
  "worktree.changes": {
    changes: Record<string, { added: number; deleted: number }>
  }
  /**
   * Text addressed INTO a task's live engine session (docs/design/
   * dispatcher.md). The daemon never owns delivery — engines are hosted
   * by front-ends (tmux panes, the web PTY sidecar), so this channel is
   * the daemon-side half of the contract: producers publish "paste this
   * into task X", and whichever front-end hosts that task's session
   * delivers it (the SPA via /pty/send today). Producers: the `note.file`
   * RPC (a worktree session's field note, forwarded to the repo's
   * main-task dispatcher, `source: "note"`) and the `session.deliver` RPC
   * (`kobe api dispatch` — the dispatcher relaying a note onward,
   * `source: "dispatcher"`). EVENT channel, not state: last-value replay
   * hands a late subscriber only the most recent item (the event-bus
   * definition-time caveat) — consumers dedupe on `at`.
   */
  "session.deliver": SessionDeliverPayload
  // Add a channel ↓ then `bus.publish(name, payload)` in the daemon and
  // `client.onChannel(name, …)` in a consumer — that's the whole recipe:
  // "cost": { taskId: string; usd: number; tokens: number }
  // "pr-status": { taskId: string; state: "open" | "merged" | "closed" | "none" }
}

/** The `session.deliver` channel payload — one "paste this into task X". */
export interface SessionDeliverPayload {
  readonly taskId: string
  readonly text: string
  /** Publish time (ms epoch) — the consumer-side dedupe key. */
  readonly at: number
  readonly source: "note" | "dispatcher"
}

/** The `ui-prefs` channel payload — the persisted visual prefs snapshot. */
export type UiPrefsPayload = ChannelPayloads["ui-prefs"]

/** The `task.jobs` channel payload — long-operation lifecycle progress. */
export type TaskJobsPayload = ChannelPayloads["task.jobs"]

/** The `worktree.changes` channel payload — daemon-collected change counts. */
export type WorktreeChangesPayload = ChannelPayloads["worktree.changes"]

/** A push-channel name (a key of {@link ChannelPayloads}). */
export type ChannelName = keyof ChannelPayloads

/** Runtime channel list — defaults subscribe-to-all + validates a filter. */
export const CHANNEL_NAMES: readonly ChannelName[] = [
  "task.snapshot",
  "issue.snapshot",
  "active-task",
  "update",
  "engine-state",
  "ui-prefs",
  "keybindings",
  "task.jobs",
  "worktree.changes",
  "session.deliver",
]

const CHANNEL_NAME_SET: ReadonlySet<string> = new Set<string>(CHANNEL_NAMES)

/** True for a string that names a real push channel. */
export function isChannelName(value: unknown): value is ChannelName {
  return typeof value === "string" && CHANNEL_NAME_SET.has(value)
}

/**
 * Normalize a subscribe `channels` request into the filter the daemon
 * enforces (KOB — per-channel subscribe). Returns `null` for "no filter →
 * deliver every channel" (back-compat: a subscriber that omits `channels`,
 * sends a non-array, or sends an empty/all-garbage list gets everything,
 * exactly as before the filter existed). Otherwise returns the set of valid
 * channel names requested — unknown names are dropped (forward-compat: a
 * newer client asking for a channel this daemon doesn't have just doesn't
 * receive it, never an error). `daemon.stopping` is intentionally NOT a
 * channel and is always delivered regardless of the filter (server.ts).
 */
export function normalizeChannelFilter(value: unknown): ReadonlySet<ChannelName> | null {
  if (!Array.isArray(value)) return null
  const set = new Set<ChannelName>()
  for (const name of value) if (isChannelName(name)) set.add(name)
  return set.size > 0 ? set : null
}

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
  /** Web-board ordering key (sparse fractional; absent until first drop). */
  readonly position?: number
  /** Engine reasoning/effort level, when the vendor supports one. */
  readonly modelEffort?: string
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
    position: task.position,
    modelEffort: task.modelEffort,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }
}

export function frameToLine(frame: DaemonFrame): string {
  return `${JSON.stringify(frame)}\n`
}
