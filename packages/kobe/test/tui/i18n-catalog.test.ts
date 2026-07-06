import { describe, expect, it } from "vitest"
import { CATALOGS, LOCALES, en } from "../../src/tui/i18n/catalog"

type Leaf = string

function flatten(obj: unknown, prefix = ""): Record<string, Leaf> {
  const out: Record<string, Leaf> = {}
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === "object") Object.assign(out, flatten(value, path))
    else out[path] = value as Leaf
  }
  return out
}

const placeholders = (s: string): string[] => (s.match(/\{(\w+)\}/g) ?? []).sort()

const enFlat = flatten(en)
const enKeys = Object.keys(enFlat).sort()

describe("i18n catalog parity", () => {
  for (const { id } of LOCALES) {
    describe(id, () => {
      const flat = flatten(CATALOGS[id])
      const keys = Object.keys(flat).sort()

      it("has exactly the English key set", () => {
        const missing = enKeys.filter((k) => !(k in flat))
        const extra = keys.filter((k) => !(k in enFlat))
        expect({ missing, extra }).toEqual({ missing: [], extra: [] })
      })

      it("has no empty values", () => {
        const empty = keys.filter((k) => flat[k].trim().length === 0)
        expect(empty).toEqual([])
      })

      it("preserves every English placeholder", () => {
        const mismatched = enKeys.filter(
          (k) => k in flat && placeholders(enFlat[k]).join(",") !== placeholders(flat[k]).join(","),
        )
        expect(mismatched).toEqual([])
      })
    })
  }
})
