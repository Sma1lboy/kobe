import { triage } from "./triage.ts"
import type { EngineState, Task } from "./types.ts"

export function attentionTaskIds(
  tasks: readonly Task[],
  engineStates: Record<string, EngineState>,
): string[] {
  return tasks
    .filter(
      (t) =>
        !t.archived &&
        t.kind !== "main" &&
        triage(engineStates[t.id], undefined) === "attention",
    )
    .map((t) => t.id)
}

export function nextAttentionTaskId(
  ids: readonly string[],
  activeId: string | null,
): string | null {
  if (ids.length === 0) return null
  const idx = activeId ? ids.indexOf(activeId) : -1
  if (idx === -1) return ids[0] ?? null
  return ids[(idx + 1) % ids.length] ?? null
}
