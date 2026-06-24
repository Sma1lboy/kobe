/**
 * Reactive translation runtime.
 *
 * Mirrors the module-level-store pattern in `tui/context/theme.tsx`: a single
 * Solid store holds the active language for the process, and `t()` reads it so
 * any `t("…")` call sitting inside JSX (a tracked scope) re-renders the moment
 * the language changes — no per-call subscription, no context threading.
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

import { createStore } from "solid-js/store"
import { CATALOGS, DEFAULT_LOCALE, LOCALES, type LocaleId, type Messages } from "./catalog"

export { LOCALES, DEFAULT_LOCALE, isLocaleId } from "./catalog"
export type { LocaleId } from "./catalog"

const [store, setStore] = createStore<{ lang: LocaleId }>({ lang: DEFAULT_LOCALE })

/** Switch the active UI language for THIS process (reactive). No-op on an unknown id. */
export function setLocaleLang(lang: LocaleId): void {
  if (CATALOGS[lang]) setStore("lang", lang)
}

/** The active language id. Reactive — reads inside a tracked scope re-run on change. */
export function currentLang(): LocaleId {
  return store.lang
}

/** Walk a dotted key (`a.b.c`) into a catalog, returning the leaf string or undefined. */
function lookup(catalog: Messages, key: string): string | undefined {
  let node: unknown = catalog
  for (const part of key.split(".")) {
    if (node && typeof node === "object" && part in (node as Record<string, unknown>)) {
      node = (node as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return typeof node === "string" ? node : undefined
}

/** Substitute `{name}` placeholders; an absent param is left literal so the gap is visible. */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

/**
 * Translate `key` for the active language. Falls back to English, then to the
 * raw key (so a missing string is loud, not blank). Reactive via `store.lang`.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const lang = store.lang
  const resolved = lookup(CATALOGS[lang], key) ?? lookup(CATALOGS.en, key) ?? key
  return interpolate(resolved, params)
}

/** The label to show for a language id in the picker (e.g. `en` → "English"). */
export function localeLabel(id: LocaleId): string {
  return LOCALES.find((l) => l.id === id)?.label ?? id
}
