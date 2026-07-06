import { useCallback, useSyncExternalStore } from "react"
import { createExternalStore } from "../../lib/external-store"
import { CATALOGS, DEFAULT_LOCALE, LOCALES, type LocaleId } from "../../tui/i18n/catalog"
import { interpolate, lookup, lookupKeys } from "../../tui/i18n/lookup"

export { LOCALES, DEFAULT_LOCALE, isLocaleId } from "../../tui/i18n/catalog"
export type { LocaleId } from "../../tui/i18n/catalog"

const langStore = createExternalStore<LocaleId>(DEFAULT_LOCALE)

export function setLocaleLang(lang: LocaleId): void {
  if (CATALOGS[lang]) langStore.set(lang)
}

export function currentLang(): LocaleId {
  return langStore.get()
}

export function t(key: string, params?: Record<string, string | number>): string {
  const lang = langStore.get()
  const resolved = lookup(CATALOGS[lang], key) ?? lookup(CATALOGS.en, key) ?? key
  return interpolate(resolved, params)
}

export function tKeys(group: "category" | "desc", key: string): string {
  const lang = langStore.get()
  return lookupKeys(CATALOGS[lang], group, key) ?? lookupKeys(CATALOGS.en, group, key) ?? key
}

export function useLang(): LocaleId {
  return useSyncExternalStore(langStore.subscribe, langStore.get, langStore.get)
}

export function useT(): typeof t {
  const lang = useLang()
  // biome-ignore lint/correctness/useExhaustiveDependencies: `lang` is the invalidation key — t reads it via the store.
  return useCallback<typeof t>((key, params) => t(key, params), [lang])
}
