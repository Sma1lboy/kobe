/**
 * React adapter over the canonical framework-free locale state. Components
 * call `useT()` (or `useLang()`) to subscribe; module-level formatting calls
 * use the same `t()` implementation without maintaining a second store.
 *
 * Repo i18n convention still holds: never capture a translation RESULT in a
 * module-level constant — that freezes the language.
 */

import { useCallback } from "react"
import { currentLang, localeState, setLocaleLang, t, tKeys } from "../../tui/i18n"
import { useAccessor } from "../lib/use-accessor"

export { LOCALES, DEFAULT_LOCALE, isLocaleId } from "../../tui/i18n/catalog"
export type { LocaleId } from "../../tui/i18n/catalog"
export { currentLang, setLocaleLang, t, tKeys }

/** Subscribe the component to the active language. */
export function useLang(): ReturnType<typeof currentLang> {
  return useAccessor(localeState())
}

/**
 * Language-subscribed `t`. The returned function is identity-stable per
 * language, so it is safe in dependency arrays and memoized children.
 */
export function useT(): typeof t {
  const lang = useLang()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lang` is the invalidation key — t reads it via the store.
  return useCallback<typeof t>((key, params) => t(key, params), [lang])
}
