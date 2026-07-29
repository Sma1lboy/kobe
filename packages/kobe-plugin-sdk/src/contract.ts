/**
 * The wire contract, typed — the SINGLE source of the plugin-facing
 * catalogs. The daemon imports these very constants (via the package's
 * `./contract` subpath, which resolves to this source file in-repo), so
 * in-repo code and external SDK consumers can never disagree. Channel
 * PAYLOAD types stay host-side (kobe-daemon channels.ts) — they reach
 * plugins as versioned `unknown`.
 */

/** Every event a plugin can subscribe to via `[[events]]`. */
export const PLUGIN_EVENT_NAMES = [
  // Product layer
  "task.created",
  "task.deleted",
  "task.landed",
  "task.archived",
  "worktree.created",
  "issue.changed",
  // Reduced activity-state transitions (deduped per task+tab)
  "agent.turn-complete",
  "agent.permission-needed",
  "agent.rate-limited",
  "agent.error",
  "agent.running",
  "agent.idle",
  // Agent lifecycle (one event per engine hook report)
  "session.start",
  "session.end",
  "turn.prompt",
  "turn.complete",
  "turn.failed",
  "turn.interrupted",
  "tool.pre",
  "tool.post",
  "tool.failed",
  "attention.permission",
  "attention.question",
  "context.pre-compact",
  "context.post-compact",
  "subagent.start",
  "subagent.stop",
  // UI layer (reported by the TUI; async observers)
  "file.will-open",
  "file.opened",
  "file.closed",
  "task.opened",
  "project.opened",
  "tab.opened",
  "tab.closed",
] as const

export type PluginEventName = (typeof PLUGIN_EVENT_NAMES)[number]

/** The task block embedded in event envelopes that map to a task. */
export interface PluginEventTask {
  readonly id: string
  readonly title?: string
  readonly repo?: string
  readonly branch?: string
  readonly worktreePath?: string
  readonly vendor?: string
  readonly status?: string
}

/** The JSON in `KOBE_PLUGIN_EVENT_JSON` — one fired event. */
export interface PluginEventEnvelope {
  readonly event: PluginEventName
  readonly taskId?: string
  readonly task?: PluginEventTask
  /** Engine vendor for agent-layer events (e.g. "claude", "codex"). */
  readonly vendor?: string
  readonly tabId?: string
  readonly sessionId?: string
  /** Per-event payload — see docs/PLUGIN-AUTHORING.md's event catalog. */
  readonly detail?: Record<string, unknown>
  /** Epoch millis when the host fired the event. */
  readonly at?: number
}

/** One newline-delimited JSON frame on the daemon socket. */
export type DaemonFrame =
  | { readonly type: "request"; readonly id: string; readonly name: string; readonly payload?: unknown }
  | {
      readonly type: "response"
      readonly id: string
      readonly name?: string
      readonly payload?: unknown
      readonly error?: { readonly message: string; readonly code?: string }
    }
  | { readonly type: "event"; readonly name: string; readonly payload: unknown }

/**
 * Broadcast channels a socket client can subscribe to. Payload shapes are
 * host-versioned (see kobe-daemon channels.ts); treat them as `unknown`
 * and validate what you read.
 */
export const DAEMON_CHANNELS = [
  "task.snapshot",
  "issue.snapshot",
  "active-task",
  "update",
  "engine-state",
  "attention.inbox",
  "ui-prefs",
  "keybindings",
  "task.jobs",
  "worktree.changes",
  "transcript.activity",
  "session.deliver",
  "tab.open",
  "engine.lifecycle",
  "notice.event",
  "usage.snapshot",
] as const

export type DaemonChannelName = (typeof DAEMON_CHANNELS)[number]
