import type { Messages } from "./catalog"

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

export function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

export function lookupKeys(catalog: Messages, group: "category" | "desc", key: string): string | undefined {
  const leaf = (catalog.keys as Record<string, Record<string, string>>)[group]
  return leaf?.[key]
}
