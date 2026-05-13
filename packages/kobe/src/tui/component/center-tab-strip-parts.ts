import type { ChatRunState } from "../../orchestrator/core"
import type { NotificationKind } from "../context/notifications"

export type ChatTabMarkerKind = "running" | "awaiting_input" | "unread_done" | "unread_needs_input"

export interface ChatTabMarkerInput {
  readonly runState: ChatRunState | undefined
  readonly unreadKind: NotificationKind | undefined
  readonly isPrimary: boolean
}

/**
 * One leading marker per chat-tab chip. Live run-state wins over stale
 * unread state; active chips suppress unread because the user is already
 * viewing that tab.
 */
export function chatTabMarkerKind(input: ChatTabMarkerInput): ChatTabMarkerKind | null {
  if (input.runState === "running") return "running"
  if (input.runState === "awaiting_input") return "awaiting_input"
  if (input.isPrimary || input.unreadKind === undefined) return null
  return input.unreadKind === "needs_input" ? "unread_needs_input" : "unread_done"
}
