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
 * Channel registry — the SINGLE source of truth for daemon→client push
 * channels. The daemon is a cross-process pub/sub bus over the
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
   * focus, instead of each pane remembering its own last click.
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
   * Tasks-pane `── keys ──` legend fold (`?`) across every session, and
   * `projectFilter` syncs the Tasks-pane project scope (`ctrl+p`) so switching
   * task sessions does not reveal another pane's stale local filter. Last-
   * value replay hydrates a late/reconnecting subscriber. `focusAccent` is
   * the raw slot string (`null` = unset → the default slot); the TUI side
   * validates it — the daemon stays vendor/UI-neutral and just mirrors the
   * file.
   */
  "ui-prefs": {
    theme: string
    transparentBackground: boolean
    focusAccent: string | null
    /** UI language id (`state.json`'s `locale`). Opaque to the daemon — the TUI validates it. */
    locale: string
    sortMode: "default" | "recent"
    keysCollapsed: boolean
    projectFilter: string | null
    /** Accessibility: chrome animations degrade to calm forms. */
    reducedMotion: boolean
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
   * Engine-transcript activity for every collected worktree (perf —
   * deduplicate per-Ops-pane polling). Today EVERY `kobe ops` pane stat'd
   * the engine's transcript dir + parsed its JSONL on its own 1.5–2.5s
   * timer (the `● new` badge's mtime probe + the ChatTab "done" chip's
   * completion-marker read) — W ChatTabs × K transcripts of duplicated
   * filesystem churn at total rest. The daemon now runs ONE collector
   * (`daemon/transcript-activity-collector.ts`) doing the shareable,
   * FILESYSTEM half — newest transcript mtime + the engine-owned completion
   * marker — and fans it out here. The per-window `tmux capture-pane`
   * quiescence check + `@kobe_tab_state` write STAY in the Ops pane process
   * (the daemon must never touch tmux), so this channel carries only the
   * fs-derived facts a window combines with its local pane hash.
   *
   * Same FULL-map-replace contract as `worktree.changes`: keys are absolute
   * LOCAL worktree paths, the payload is the whole map republished only when
   * an entry changed, archived/remote tasks are never collected, and a
   * deleted/archived task's entry drops on the next tick. `completionId` is
   * the engine's opaque latest-completion marker id (`null` when the vendor
   * has none or none exists yet); `completionAt` is its epoch-ms timestamp
   * (`0` when absent). A `Record` (not a Map) — JSON wire payload. Clients
   * on an older daemon (channel absent from `hello.capabilities`) fall back
   * to the Ops pane's local polling.
   */
  "transcript.activity": {
    activity: Record<string, { mtimeMs: number; completionId: string | null; completionAt: number }>
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

/** The `worktree.changes` channel payload — daemon-collected change counts. */
export type WorktreeChangesPayload = ChannelPayloads["worktree.changes"]

/** The `transcript.activity` channel payload — daemon-collected transcript facts. */
export type TranscriptActivityPayload = ChannelPayloads["transcript.activity"]

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
  "transcript.activity",
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
}

/** `pty.open` response — attach result for one session key. */
export interface PtyOpenResult {
  /** Ring-buffer replay (base64) — everything the child wrote, capped. */
  readonly replay: string
  /** False when the session exists but its child already exited. */
  readonly alive: boolean
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
