import type { EngineOption } from "./engines.ts"
import type { Task } from "./types.ts"

export const DEFAULT_VENDOR = "claude"

export function resolveVendor(id: string | undefined): string {
  return id || DEFAULT_VENDOR
}

export function engineLabel(
  list: readonly EngineOption[],
  id: string | undefined,
): string {
  const resolved = resolveVendor(id)
  return list.find((e) => e.id === resolved)?.label ?? resolved
}

export function distinctTaskVendors(tasks: readonly Task[]): string[] {
  const set = new Set<string>()
  for (const task of tasks) {
    if (task.archived || task.kind === "main") continue
    set.add(resolveVendor(task.vendor))
  }
  return [...set]
}

export function isMixedEngineWorkspace(tasks: readonly Task[]): boolean {
  return distinctTaskVendors(tasks).length > 1
}

export function perRowEngineLabel(
  list: readonly EngineOption[],
  task: Task,
  mixed: boolean,
): string | null {
  return mixed && task.kind !== "main" ? engineLabel(list, task.vendor) : null
}
