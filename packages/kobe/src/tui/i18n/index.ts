/**
 * Reactive translation runtime.
 *
 * One framework-free state cell holds the active language for the process.
 * Framework-free callers read `t()` directly; React subscribes to the same
 * cell through `useSyncExternalStore` in `tui-react/i18n`.
 *
 * Persistence is handled the same way the theme is: the booter seeds the
 * language from `state.json` (`readPersistedUiPrefs().locale`) via
 * {@link setLocaleLang}, and the Settings switcher calls `setLocaleLang` +
 * `kv.set("locale", …)`. This module owns the in-memory reactive value only.
 *
 * IMPORTANT (matches the repo's i18n convention): import the `t` FUNCTION at
 * module scope and call it inside the render/getter — never capture `t("…")`'s
 * RESULT in a module-level constant, which would freeze the language.
 */

import { type ReadableState, createStateCell } from "../../lib/external-store"
import { CATALOGS, DEFAULT_LOCALE, LOCALES, type LocaleId } from "./catalog"
import { interpolate, lookup, lookupKeys } from "./lookup"

export { LOCALES, DEFAULT_LOCALE, isLocaleId } from "./catalog"
export type { LocaleId } from "./catalog"

const langState = createStateCell<LocaleId>(DEFAULT_LOCALE)

/** Switch the active UI language for THIS process (reactive). No-op on an unknown id. */
export function setLocaleLang(lang: LocaleId): void {
  if (CATALOGS[lang]) langState.set(lang)
}

/** The active language id. */
export function currentLang(): LocaleId {
  return langState.get()
}

/** Read-only process locale state for UI adapters. */
export function localeState(): ReadableState<LocaleId> {
  return langState
}

/**
 * Translate `key` for the active language. Falls back to English, then to the
 * raw key (so a missing string is loud, not blank). Reactive via `store.lang`.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const lang = langState.get()
  const resolved = lookup(CATALOGS[lang], key) ?? lookup(CATALOGS.en, key) ?? key
  return interpolate(resolved, params)
}

/**
 * Lookup for the keybinding catalog (`keys.category.*` / `keys.desc.*`),
 * where the lookup key is itself a binding id like `chat.tab.new` whose dots
 * would mis-split the generic dotted `t()` path. Indexes the leaf record by
 * the EXACT key string instead. Reactive via `store.lang`; English fallback,
 * then the raw key (so an unmapped binding shows its id, never blank).
 */
export function tKeys(group: "category" | "desc", key: string): string {
  const lang = langState.get()
  return lookupKeys(CATALOGS[lang], group, key) ?? lookupKeys(CATALOGS.en, group, key) ?? key
}
