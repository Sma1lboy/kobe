import type { ActivityState } from "./types.ts"

export interface ActivityMeta {
  readonly color: string
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
