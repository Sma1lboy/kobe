import type { EngineState } from "./types.ts"

export type Bucket = "attention" | "working" | "changes" | "quiet"

export function triage(
  engine: EngineState | undefined,
  changes: { added: number; deleted: number } | undefined,
): Bucket {
  const state = engine?.state
  if (
    state === "waiting_permission" ||
    state === "error" ||
    state === "rate_limited"
  ) {
    return "attention"
  }
  if (state === "running") return "working"
  if (changes && (changes.added > 0 || changes.deleted > 0)) return "changes"
  return "quiet"
}

export function matchesStatusFilter(
  engine: EngineState | undefined,
  changes: { added: number; deleted: number } | undefined,
  filter: Bucket | "all",
): boolean {
  return filter === "all" || triage(engine, changes) === filter
}
