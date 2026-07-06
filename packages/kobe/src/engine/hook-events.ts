export const ENGINE_ACTIVITY_KINDS = [
  "session-start",
  "turn-start",
  "turn-complete",
  "turn-failed",
  "awaiting-input",
  "session-end",
] as const
export type EngineActivityKind = (typeof ENGINE_ACTIVITY_KINDS)[number]

export function isEngineActivityKind(v: string): v is EngineActivityKind {
  return (ENGINE_ACTIVITY_KINDS as readonly string[]).includes(v)
}

export interface EngineActivityDetail {
  readonly failure?: "rate_limit" | "billing" | "other"
  readonly waiting?: "permission" | "input"
  readonly note?: string
}

export const TASK_ACTIVITY_STATES = [
  "idle",
  "running",
  "turn_complete",
  "rate_limited",
  "permission_needed",
  "error",
] as const
export type TaskActivityState = (typeof TASK_ACTIVITY_STATES)[number]

export function reduceActivity(
  _prev: TaskActivityState | undefined,
  kind: EngineActivityKind,
  detail?: EngineActivityDetail,
): TaskActivityState {
  switch (kind) {
    case "session-start":
    case "session-end":
      return "idle"
    case "turn-start":
      return "running"
    case "turn-complete":
      return "turn_complete"
    case "turn-failed":
      return detail?.failure === "rate_limit" || detail?.failure === "billing" ? "rate_limited" : "error"
    case "awaiting-input":
      return detail?.waiting === "permission" ? "permission_needed" : "running"
  }
}
