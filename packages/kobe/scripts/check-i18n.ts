#!/usr/bin/env bun

import { CATALOGS, LOCALES, en } from "../src/tui/i18n/catalog.ts"

function flatten(obj: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === "object") Object.assign(out, flatten(value, path))
    else out[path] = value as string
  }
  return out
}

const placeholders = (s: string): string => (s.match(/\{(\w+)\}/g) ?? []).sort().join(",")

const enFlat = flatten(en)
const enKeys = Object.keys(enFlat)
const problems: string[] = []

for (const { id } of LOCALES) {
  if (id === "en") continue
  const flat = flatten(CATALOGS[id])
  const missing = enKeys.filter((k) => !(k in flat))
  const extra = Object.keys(flat).filter((k) => !(k in enFlat))
  const empty = Object.keys(flat).filter((k) => flat[k].trim().length === 0)
  const badPlaceholders = enKeys.filter((k) => k in flat && placeholders(enFlat[k]) !== placeholders(flat[k]))
  if (missing.length) problems.push(`[${id}] missing keys:\n  ${missing.join("\n  ")}`)
  if (extra.length) problems.push(`[${id}] extra keys (not in en):\n  ${extra.join("\n  ")}`)
  if (empty.length) problems.push(`[${id}] empty values:\n  ${empty.join("\n  ")}`)
  if (badPlaceholders.length) problems.push(`[${id}] placeholder mismatch vs en:\n  ${badPlaceholders.join("\n  ")}`)
}

if (problems.length) {
  console.error(`i18n check FAILED:\n\n${problems.join("\n\n")}`)
  process.exit(1)
}

console.log(`i18n check OK — ${enKeys.length} keys × ${LOCALES.length} locales in sync`)
