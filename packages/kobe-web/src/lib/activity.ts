/**
 * Shared engine-activity presentation — the dot color + human label for a
 * task's transient engine state. Used by the task rail (AppShell) and the
 * Overview triage view so the two never drift.
 */

import type { ActivityState } from "./types.ts"

export function activityColor(state: ActivityState | undefined): string {
  switch (state) {
    case "running":
      return "bg-kobe-orange"
    case "waiting_permission":
      return "bg-kobe-blue"
    case "rate_limited":
      return "bg-kobe-yellow"
    case "error":
      return "bg-kobe-red"
    case "idle":
      return "bg-kobe-green/60"
    default:
      return "bg-subtle"
  }
}

export function activityLabel(state: ActivityState | undefined): string {
  switch (state) {
    case "running":
      return "running"
    case "waiting_permission":
      return "needs input"
    case "rate_limited":
      return "rate limited"
    case "error":
      return "error"
    case "idle":
      return "idle"
    default:
      return ""
  }
}
