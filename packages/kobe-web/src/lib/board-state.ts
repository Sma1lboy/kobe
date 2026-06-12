/**
 * Board view state that must survive route changes — a module store (the
 * tabs.ts pattern), NOT component useState, so navigating board → task →
 * board keeps the filter (the issue #7 lesson: route-local state resets on
 * the first navigation because the view unmounts).
 *
 * Deliberately not persisted to localStorage: a filter that outlives the
 * browser session is surprising on a fresh load.
 */

import { useSyncExternalStore } from "react"
import { type BoardOverrides, reconcileOverrides } from "./board.ts"
import type { Task } from "./types.ts"

interface BoardState {
  /** Free-text card filter (matchesTask semantics). */
  query: string
  /** Pending optimistic drops: taskId → expected fields (board.ts R4). */
  overrides: BoardOverrides
}

let state: BoardState = { query: "", overrides: {} }
const listeners = new Set<() => void>()

function set(next: Partial<BoardState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): BoardState {
  return state
}

/** Plain read for non-React callers (and tests). */
export function getBoardState(): BoardState {
  return state
}

export function useBoardState(): BoardState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

export function setBoardQuery(query: string): void {
  if (query !== state.query) set({ query })
}

/** Record an optimistic status drop — the card paints into its target
 *  column now. */
export function setStatusOverride(taskId: string, status: string): void {
  set({
    overrides: {
      ...state.overrides,
      [taskId]: { ...state.overrides[taskId], status },
    },
  })
}

/** Record an optimistic in-column placement. */
export function setPositionOverride(taskId: string, position: number): void {
  set({
    overrides: {
      ...state.overrides,
      [taskId]: { ...state.overrides[taskId], position },
    },
  })
}

/** Batch variant for a renormalized column (one entry per card). */
export function setPositionOverrides(
  moves: ReadonlyArray<{ taskId: string; position: number }>,
): void {
  const overrides = { ...state.overrides }
  for (const move of moves) {
    overrides[move.taskId] = {
      ...overrides[move.taskId],
      position: move.position,
    }
  }
  set({ overrides })
}

/** Drop a field from an entry, dropping the entry when it empties. */
function clearField(
  overrides: BoardOverrides,
  taskId: string,
  field: "status" | "position",
  expected: string | number,
): BoardOverrides {
  const entry = overrides[taskId]
  if (!entry || entry[field] !== expected) return overrides
  const { [field]: _gone, ...kept } = entry
  const next = { ...overrides }
  if (kept.status === undefined && kept.position === undefined) {
    delete next[taskId]
  } else {
    next[taskId] = kept
  }
  return next
}

/** Roll back ONE failed status drop. Clears only if the pending override
 *  still is the one that failed — a newer drag on the same card must survive
 *  an older RPC's rejection. */
export function clearStatusOverride(taskId: string, status: string): void {
  const next = clearField(state.overrides, taskId, "status", status)
  if (next !== state.overrides) set({ overrides: next })
}

/** Roll back ONE failed placement (same value-match guard as status). */
export function clearPositionOverride(taskId: string, position: number): void {
  const next = clearField(state.overrides, taskId, "position", position)
  if (next !== state.overrides) set({ overrides: next })
}

/** Roll back a failed renormalize batch. */
export function clearPositionOverrides(
  moves: ReadonlyArray<{ taskId: string; position: number }>,
): void {
  let next = state.overrides
  for (const move of moves) {
    next = clearField(next, move.taskId, "position", move.position)
  }
  if (next !== state.overrides) set({ overrides: next })
}

/** Reconcile pending overrides against an authoritative task list — clears
 *  confirmed/vanished ones, keeps in-flight ones (board.ts semantics). */
export function reconcileBoardOverrides(tasks: Task[]): void {
  const next = reconcileOverrides(state.overrides, tasks)
  if (next !== state.overrides) set({ overrides: next })
}

/** Test-only reset so cases don't leak filter state into each other. */
export function resetBoardStateForTest(): void {
  state = { query: "", overrides: {} }
}
