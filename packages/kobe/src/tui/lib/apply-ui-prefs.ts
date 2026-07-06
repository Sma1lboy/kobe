export const UI_PREFS_FOCUS_ACCENT_SLOTS = ["primary", "success", "info"] as const
export type UiPrefsFocusAccentSlot = (typeof UI_PREFS_FOCUS_ACCENT_SLOTS)[number]

export const DEFAULT_FOCUS_ACCENT_SLOT: UiPrefsFocusAccentSlot = "primary"

export interface UiPrefsSnapshot {
  readonly theme?: unknown
  readonly transparentBackground?: unknown
  readonly focusAccent?: unknown
}

export interface UiPrefsTarget {
  selectedTheme(): string
  hasTheme(name: string): boolean
  setTheme(name: string): boolean
  reloadUserThemes(): void
  transparentBackground(): boolean
  setTransparentBackground(v: boolean): void
  focusAccent(): string
  setFocusAccent(slot: UiPrefsFocusAccentSlot): void
}

export function applyUiPrefs(target: UiPrefsTarget, prefs: UiPrefsSnapshot): void {
  if (typeof prefs.theme === "string" && prefs.theme.length > 0 && prefs.theme !== target.selectedTheme()) {
    if (!target.hasTheme(prefs.theme)) target.reloadUserThemes()
    if (target.hasTheme(prefs.theme)) target.setTheme(prefs.theme)
  }

  if (
    typeof prefs.transparentBackground === "boolean" &&
    prefs.transparentBackground !== target.transparentBackground()
  ) {
    target.setTransparentBackground(prefs.transparentBackground)
  }

  if (prefs.focusAccent === null || typeof prefs.focusAccent === "string") {
    const slot = normalizeFocusAccent(prefs.focusAccent)
    if (slot && slot !== target.focusAccent()) target.setFocusAccent(slot)
  }
}

export function normalizeFocusAccent(value: string | null): UiPrefsFocusAccentSlot | null {
  if (value === null) return DEFAULT_FOCUS_ACCENT_SLOT
  return (UI_PREFS_FOCUS_ACCENT_SLOTS as readonly string[]).includes(value) ? (value as UiPrefsFocusAccentSlot) : null
}
