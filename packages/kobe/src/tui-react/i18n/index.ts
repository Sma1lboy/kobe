/**
 * React translation runtime (issue #15, G2) — the `src/tui/i18n/index.ts`
 * counterpart for React panes. Same catalogs, same resolution rules (shared
 * `../../tui/i18n/lookup`), different reactivity story:
 *
 * Under Solid, a bare `t("…")` inside JSX subscribes to the language store
 * automatically. React has no tracked scopes, so a component that wants to
 * re-render on language change MUST call `useT()` (or `useLang()`) and use
 * the returned function — that hook subscribes via `useSyncExternalStore`.
 * The module-level `t()` stays available for non-component code (log lines,
 * one-shot formatting) where re-render doesn't apply.
 *
 * Repo i18n convention still holds: never capture a translation RESULT in a
 * module-level constant — that freezes the language.
 */

import { useCallback, useSyncExternalStore } from "react"
import { createExternalStore } from "../../lib/external-store"
import { CATALOGS, DEFAULT_LOCALE, LOCALES, type LocaleId } from "../../tui/i18n/catalog"
import { interpolate, lookup, lookupKeys } from "../../tui/i18n/lookup"

export { LOCALES, DEFAULT_LOCALE, isLocaleId } from "../../tui/i18n/catalog"
export type { LocaleId } from "../../tui/i18n/catalog"

const langStore = createExternalStore<LocaleId>(DEFAULT_LOCALE)

/** Switch the active UI language for THIS process. No-op on an unknown id. */
export function setLocaleLang(lang: LocaleId): void {
  if (CATALOGS[lang]) langStore.set(lang)
}

/** The active language id (non-reactive read; components use `useLang`). */
export function currentLang(): LocaleId {
  return langStore.get()
}

/**
 * Translate `key` for the active language. Falls back to English, then to
 * the raw key (a missing string is loud, not blank). NOT reactive — inside
 * components use `useT()` so the caller re-renders on language change.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const lang = langStore.get()
  const resolved = lookup(CATALOGS[lang], key) ?? lookup(CATALOGS.en, key) ?? key
  return interpolate(resolved, params)
}

/** Keybinding-catalog lookup (`keys.category.*` / `keys.desc.*`) by exact id. */
export function tKeys(group: "category" | "desc", key: string): string {
  const lang = langStore.get()
  return lookupKeys(CATALOGS[lang], group, key) ?? lookupKeys(CATALOGS.en, group, key) ?? key
}

/** Subscribe the component to the active language. */
export function useLang(): LocaleId {
  return useSyncExternalStore(langStore.subscribe, langStore.get, langStore.get)
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
