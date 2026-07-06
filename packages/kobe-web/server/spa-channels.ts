import type { ChannelName } from "@sma1lboy/kobe-daemon/daemon/protocol"

export const SPA_CHANNELS: readonly ChannelName[] = [
  "task.snapshot",
  "issue.snapshot",
  "active-task",
  "engine-state",
  "update",
  "task.jobs",
  "worktree.changes",
  "session.deliver",
  "ui-prefs",
]

export const SPA_CHANNEL_SET: ReadonlySet<string> = new Set<string>(SPA_CHANNELS)
