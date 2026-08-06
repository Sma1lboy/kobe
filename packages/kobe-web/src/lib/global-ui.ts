import { createExternalStore } from "./external-store.ts"

/** What the /chat main area shows: the selected session or an embedded page. */
export type ChatSurface = "chat" | "board" | "routines"

interface GlobalUiState {
  paletteOpen: boolean
  helpOpen: boolean
  newTaskOpen: boolean
  settingsOpen: boolean
  /** Global so the command palette (root-level) can drive the /chat shell. */
  chatSurface: ChatSurface
  chatSelectedTaskId: string | null
}

const store = createExternalStore<GlobalUiState>({
  paletteOpen: false,
  helpOpen: false,
  newTaskOpen: false,
  settingsOpen: false,
  chatSurface: "chat",
  chatSelectedTaskId: null,
})

export function useGlobalUiState(): GlobalUiState {
  return store.useSnapshot()
}

export function openCommandPalette(): void {
  store.update((state) => ({ ...state, paletteOpen: true }))
}

export function closeCommandPalette(): void {
  store.update((state) => ({ ...state, paletteOpen: false }))
}

export function toggleCommandPalette(): void {
  store.update((state) => ({ ...state, paletteOpen: !state.paletteOpen }))
}

export function openKeyboardHelp(): void {
  store.update((state) => ({ ...state, helpOpen: true }))
}

export function closeKeyboardHelp(): void {
  store.update((state) => ({ ...state, helpOpen: false }))
}

export function openNewTask(): void {
  store.update((state) => ({ ...state, newTaskOpen: true }))
}

export function closeNewTask(): void {
  store.update((state) => ({ ...state, newTaskOpen: false }))
}

export function setChatSurface(surface: ChatSurface): void {
  store.update((state) => ({ ...state, chatSurface: surface }))
}

/** Select a task on the /chat shell (and snap its surface back to chat). */
export function selectChatTask(taskId: string): void {
  store.update((state) => ({
    ...state,
    chatSurface: "chat",
    chatSelectedTaskId: taskId,
  }))
}

export function openSettings(): void {
  store.update((state) => ({ ...state, settingsOpen: true }))
}

export function closeSettings(): void {
  store.update((state) => ({ ...state, settingsOpen: false }))
}
