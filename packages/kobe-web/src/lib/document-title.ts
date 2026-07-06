import { triage } from "./triage.ts"
import type { EngineState, Task } from "./types.ts"

export const BASE_TITLE = "kobe"

export function attentionCount(
  tasks: readonly Task[],
  engineStates: Record<string, EngineState>,
): number {
  let count = 0
  for (const task of tasks) {
    if (task.archived || task.kind === "main") continue
    if (triage(engineStates[task.id], undefined) === "attention") count++
  }
  return count
}

export function documentTitle(count: number): string {
  return count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE
}
