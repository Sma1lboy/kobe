/**
 * Board view state that must survive route changes — a module store (the
 * tabs.ts pattern), NOT component useState, so navigating board → task →
 * board keeps the filter (the issue #7 lesson: route-local state resets on
 * the first navigation because the view unmounts).
 *
 * The board is issues-only and non-optimistic (the daemon issue.snapshot is
 * truth), so there's no optimistic-override layer here any more — just the two
 * display filters. Deliberately not persisted to localStorage: a filter that
 * outlives the browser session is surprising on a fresh load.
 */

import { useSyncExternalStore } from "react"

interface BoardState {
  /** Free-text card filter (matches #id / title / body). */
  query: string
  /** Project chip filter: a repo key, or null = all projects. */
  repo: string | null
}

let state: BoardState = {
  query: "",
  repo: null,
}
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

/** Select a project chip (null = all). Composes with the text query. */
export function setBoardRepo(repo: string | null): void {
  if (repo !== state.repo) set({ repo })
}

/** Test-only reset so cases don't leak filter state into each other. */
export function resetBoardStateForTest(): void {
  state = { query: "", repo: null }
}
