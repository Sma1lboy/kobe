import { readFileSync } from "node:fs"
import { kvStatePath } from "../../env.ts"
import { FOCUS_ACCENT_SLOTS, type FocusAccentSlot, hasTheme } from "../context/theme"
import { DEFAULT_LOCALE, type LocaleId, isLocaleId } from "../i18n/catalog"

export const LOCALE_KEY = "locale"

export interface PersistedUiPrefs {
  readonly theme: string
  readonly transparent: boolean
  readonly focusAccent: FocusAccentSlot | null
  readonly locale: LocaleId
}

export function readPersistedUiPrefs(fallbackTheme: string): PersistedUiPrefs {
  try {
    const parsed = JSON.parse(readFileSync(kvStatePath(), "utf8")) as Record<string, unknown>
    const theme =
      typeof parsed.activeTheme === "string" && hasTheme(parsed.activeTheme) ? parsed.activeTheme : fallbackTheme
    const transparent = parsed.transparentBackground === true
    const focusAccent =
      typeof parsed.focusAccent === "string" && (FOCUS_ACCENT_SLOTS as readonly string[]).includes(parsed.focusAccent)
        ? (parsed.focusAccent as FocusAccentSlot)
        : null
    const locale = isLocaleId(parsed[LOCALE_KEY]) ? parsed[LOCALE_KEY] : DEFAULT_LOCALE
    return { theme, transparent, focusAccent, locale }
  } catch {
    return { theme: fallbackTheme, transparent: false, focusAccent: null, locale: DEFAULT_LOCALE }
  }
}
