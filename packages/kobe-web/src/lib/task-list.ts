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

import { textMatchesQuery } from "./text-match.ts"
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

// Vendor aggregations (distinctTaskVendors / isMixedEngineWorkspace) moved to
// ./vendor.ts — they're vendor-identity rules, not list ordering/filtering.

export function matchesTask(task: Task, query: string): boolean {
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
  return textMatchesQuery(haystack, query)
}
