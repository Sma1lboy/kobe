import { createExternalStore } from "./external-store.ts"

interface BoardState {
  query: string
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

export function getBoardState(): BoardState {
  return store.getSnapshot()
}

export function useBoardState(): BoardState {
  return store.useSnapshot()
}

export function setBoardQuery(query: string): void {
  if (query !== store.getSnapshot().query) set({ query })
}

export function setBoardRepo(repo: string | null): void {
  if (repo !== store.getSnapshot().repo) set({ repo })
}

export function resetBoardStateForTest(): void {
  store.replace(initial)
}
