/**
 * Push-channel registry — the SINGLE source of truth for daemon→client push
 * channels, plus the subscribe-filter helpers. Split from protocol.ts (which
 * keeps version negotiation, the frame grammar, request names, and the PTY
 * payloads) and re-exported there, so `./protocol.ts` stays the one public
 * import path for the wire protocol.
 */

import type { EngineActivityDetail, TaskActivityState, UpdateInfo } from "./contracts.ts"
import type { RepoIssues } from "./issues-store.ts"
import type { SerializedTask } from "./protocol.ts"

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
  /**
   * One toast for the attached UIs (`kobe api notify` → `notice.send` →
   * here). EVENT channel, not state: last-value replay hands a late
   * subscriber only the most recent notice — consumers dedupe on `at`
   * and drop stale replays.
   */
  "notice.event": NoticeEventPayload
  // Add a channel ↓ then `bus.publish(name, payload)` in the daemon and
  // `client.onChannel(name, …)` in a consumer — that's the whole recipe:
  // "cost": { taskId: string; usd: number; tokens: number }
  // "pr-status": { taskId: string; state: "open" | "merged" | "closed" | "none" }
}

/** The `notice.event` channel payload — one toast for every attached UI. */
export interface NoticeEventPayload {
  readonly title: string
  /**
   * Free-form kind tag. The TUI styles the known severities
   * ("done" / "needs_input" / "error" — its NotificationKind vocabulary)
   * and renders anything else neutrally, so agents may invent their own.
   */
  readonly kind: string
  /** Optional task the notice concerns (drives the sidebar unread mark). */
  readonly taskId?: string
  /** Publish time (ms epoch) — the consumer-side dedupe key. */
  readonly at: number
  /** Free-form origin tag (e.g. "api", an agent name). */
  readonly source?: string
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
  "notice.event",
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
