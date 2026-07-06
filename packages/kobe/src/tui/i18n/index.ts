import { createStore } from "solid-js/store"
import { CATALOGS, DEFAULT_LOCALE, LOCALES, type LocaleId } from "./catalog"
import { interpolate, lookup, lookupKeys } from "./lookup"

export { LOCALES, DEFAULT_LOCALE, isLocaleId } from "./catalog"
export type { LocaleId } from "./catalog"

const [store, setStore] = createStore<{ lang: LocaleId }>({ lang: DEFAULT_LOCALE })

export function setLocaleLang(lang: LocaleId): void {
  if (CATALOGS[lang]) setStore("lang", lang)
}

export function currentLang(): LocaleId {
  return store.lang
}

export function t(key: string, params?: Record<string, string | number>): string {
  const lang = store.lang
  const resolved = lookup(CATALOGS[lang], key) ?? lookup(CATALOGS.en, key) ?? key
  return interpolate(resolved, params)
}

export function tKeys(group: "category" | "desc", key: string): string {
  const lang = store.lang
  return lookupKeys(CATALOGS[lang], group, key) ?? lookupKeys(CATALOGS.en, group, key) ?? key
}
