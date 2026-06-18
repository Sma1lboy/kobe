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

import { createExternalStore } from "./external-store.ts"

interface BoardState {
  /** Free-text card filter (matches #id / title / body). */
  query: string
  /** Project chip filter: a repo key, or null = all projects. */
  repo: string | null
}

const initial: BoardState = {
  query: "",
  repo: null,
}

function set(next: Partial<BoardState>): void {
  store.update((state) => ({ ...state, ...next }))
}

const store = createExternalStore(initial)

/** Plain read for non-React callers (and tests). */
export function getBoardState(): BoardState {
  return store.getSnapshot()
}

export function useBoardState(): BoardState {
  return store.useSnapshot()
}

export function setBoardQuery(query: string): void {
  if (query !== store.getSnapshot().query) set({ query })
}

/** Select a project chip (null = all). Composes with the text query. */
export function setBoardRepo(repo: string | null): void {
  if (repo !== store.getSnapshot().repo) set({ repo })
}

/** Test-only reset so cases don't leak filter state into each other. */
export function resetBoardStateForTest(): void {
  store.replace(initial)
}
