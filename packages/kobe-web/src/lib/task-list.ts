/**
 * Task-rail ordering + filtering — pure list logic shared out of AppShell so
 * it's unit-testable (the activity.ts / triage.ts precedent).
 *
 * Ordering is grouped, not flat: projects (the `main` repo rows) always sit
 * above pinned tasks, which sit above regular tasks — that grouping holds in
 * BOTH sort modes. `recent` orders the WORKTREE groups (pinned, regular) by
 * last update (newest first, id as a stable tiebreak); `default` leaves them
 * in incoming order. Projects "sit tight": they keep a stable order in both
 * modes (selecting a project bumps its updatedAt, but recent must not reshuffle
 * the project list under the user).
 */

import type { Task } from "./types.ts"

export type TaskSortMode = "default" | "recent"

function taskUpdatedMs(task: Task): number {
  const parsed = Date.parse(task.updatedAt || task.createdAt)
  return Number.isFinite(parsed) ? parsed : 0
}

function compareRecent(a: Task, b: Task): number {
  const byTime = taskUpdatedMs(b) - taskUpdatedMs(a)
  if (byTime !== 0) return byTime
  return b.id.localeCompare(a.id)
}

export function sortTasks(tasks: Task[], mode: TaskSortMode): Task[] {
  const projects = tasks.filter((task) => task.kind === "main")
  const pinned = tasks.filter((task) => task.kind !== "main" && task.pinned)
  const regular = tasks.filter((task) => task.kind !== "main" && !task.pinned)
  if (mode === "recent") {
    // Projects deliberately NOT sorted — they sit tight in both modes; only
    // the worktree groups reorder by recency.
    pinned.sort(compareRecent)
    regular.sort(compareRecent)
  }
  return [...projects, ...pinned, ...regular]
}

/** Distinct engine vendors among the live worktree tasks (undefined → the
 *  default "claude", matching engineLabel's fallback; project/archived rows
 *  excluded — they aren't sessions). */
export function distinctTaskVendors(tasks: readonly Task[]): string[] {
  const set = new Set<string>()
  for (const task of tasks) {
    if (task.archived || task.kind === "main") continue
    set.add(task.vendor ?? "claude")
  }
  return [...set]
}

/** True when the workspace runs more than one engine — only then is a
 *  per-task engine chip worth the visual noise (a single-engine workspace
 *  would just repeat the same label on every row). */
export function isMixedEngineWorkspace(tasks: readonly Task[]): boolean {
  return distinctTaskVendors(tasks).length > 1
}

export function matchesTask(task: Task, query: string): boolean {
  if (!query) return true
  const haystack = [
    task.title,
    task.branch,
    task.repo,
    task.worktreePath,
    task.vendor,
    task.status,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return haystack.includes(query.toLowerCase())
}
