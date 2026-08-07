import { createExternalStore } from "./external-store.ts"

interface GlobalUiState {
  paletteOpen: boolean
  helpOpen: boolean
  newTaskOpen: boolean
  settingsOpen: boolean
}

const store = createExternalStore<GlobalUiState>({
  paletteOpen: false,
  helpOpen: false,
  newTaskOpen: false,
  settingsOpen: false,
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

export function openSettings(): void {
  store.update((state) => ({ ...state, settingsOpen: true }))
}

export function closeSettings(): void {
  store.update((state) => ({ ...state, settingsOpen: false }))
}
