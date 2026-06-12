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

interface BoardState {
  /** Free-text card filter (matchesTask semantics). */
  query: string
}

let state: BoardState = { query: "" }
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

/** Test-only reset so cases don't leak filter state into each other. */
export function resetBoardStateForTest(): void {
  state = { query: "" }
}
