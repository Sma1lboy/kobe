/**
 * Framework-free catalog lookup + interpolation, shared by the Solid i18n
 * runtime (`./index.ts`) and the React one (`src/tui-react/i18n/index.ts`).
 * Extracted during the React migration (issue #15, G2) so neither runtime
 * duplicates the resolution rules.
 */

import type { Messages } from "./catalog"

/** Walk a dotted key (`a.b.c`) into a catalog, returning the leaf string or undefined. */
export function lookup(catalog: Messages, key: string): string | undefined {
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
export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

/**
 * Lookup for the keybinding catalog (`keys.category.*` / `keys.desc.*`),
 * where the lookup key is itself a binding id like `chat.tab.new` whose dots
 * would mis-split the generic dotted path. Indexes the leaf record by the
 * EXACT key string instead.
 */
export function lookupKeys(catalog: Messages, group: "category" | "desc", key: string): string | undefined {
  const leaf = (catalog.keys as Record<string, Record<string, string>>)[group]
  return leaf?.[key]
}
