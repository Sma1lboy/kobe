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
import { reconcileOverrides, type StatusOverrides } from "./board.ts"
import type { Task } from "./types.ts"

interface BoardState {
  /** Free-text card filter (matchesTask semantics). */
  query: string
  /** Pending optimistic drops: taskId → expected status (board.ts R4). */
  overrides: StatusOverrides
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

/** Record an optimistic drop — the card paints into its target column now. */
export function setStatusOverride(taskId: string, status: string): void {
  set({ overrides: { ...state.overrides, [taskId]: status } })
}

/** Roll back ONE failed drop. Clears only if the pending override still is
 *  the one that failed — a newer drag on the same card must survive an older
 *  RPC's rejection. */
export function clearStatusOverride(taskId: string, status: string): void {
  if (state.overrides[taskId] !== status) return
  const { [taskId]: _gone, ...rest } = state.overrides
  set({ overrides: rest })
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
