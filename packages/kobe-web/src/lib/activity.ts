/**
 * Shared engine-activity presentation — the dot color + human label for a
 * task's transient engine state. Used by the task rail (AppShell), the board
 * peek, and the command palette so the surfaces never drift.
 *
 * Color and label are derived together in ONE switch ({@link activityMeta}) so
 * a new engine state can't get a color without a label (or vice-versa); the
 * `activityColor` / `activityLabel` accessors stay for call sites that need
 * just one (a bare status dot wants only the color).
 *
 * Deliberately NOT merged with triage.ts or notify.ts: those encode different
 * policies over the same enum (see ADR 0002) — `rate_limited` is an attention
 * bucket in the UI but is NOT a desktop-notification trigger.
 */

import type { ActivityState } from "./types.ts"

export interface ActivityMeta {
  /** Tailwind `bg-*` class for the status dot. */
  readonly color: string
  /** Human label; empty for an unknown/absent state. */
  readonly label: string
}

export function activityMeta(state: ActivityState | undefined): ActivityMeta {
  switch (state) {
    case "running":
      return { color: "bg-kobe-orange", label: "running" }
    case "waiting_permission":
      return { color: "bg-kobe-blue", label: "needs input" }
    case "rate_limited":
      return { color: "bg-kobe-yellow", label: "rate limited" }
    case "error":
      return { color: "bg-kobe-red", label: "error" }
    case "idle":
      return { color: "bg-kobe-green/60", label: "idle" }
    default:
      return { color: "bg-subtle", label: "" }
  }
}

export function activityColor(state: ActivityState | undefined): string {
  return activityMeta(state).color
}

export function activityLabel(state: ActivityState | undefined): string {
  return activityMeta(state).label
}
