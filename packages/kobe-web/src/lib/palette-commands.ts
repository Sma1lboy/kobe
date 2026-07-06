import type { Task } from "./types.ts"

export function orderTasksForPalette(tasks: readonly Task[]): Task[] {
  return tasks
    .filter((task) => !task.archived)
    .sort((a, b) => {
      const at = Date.parse(a.updatedAt || a.createdAt) || 0
      const bt = Date.parse(b.updatedAt || b.createdAt) || 0
      return bt !== at ? bt - at : b.id.localeCompare(a.id)
    })
}

export interface ThemeCommandEntry {
  id: string
  label: string
  hint: string
  name: string
}

export function themeCommandEntries(
  names: readonly string[],
  active: string | null,
): ThemeCommandEntry[] {
  return names.map((name) => ({
    id: `theme:${name}`,
    label: `Theme: ${name}`,
    hint: name === active ? "active" : "theme",
    name,
  }))
}
