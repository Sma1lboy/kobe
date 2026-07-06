import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { SECTIONS } from "../../src/tui/component/settings-dialog/model"
import { en } from "../../src/tui/i18n/catalog"
import { UI_PREFS_FOCUS_ACCENT_SLOTS } from "../../src/tui/lib/apply-ui-prefs"

const TUI_ROOT = fileURLToPath(new URL("../../src/tui", import.meta.url))

const NAMESPACES = Object.keys(en)

function flatten(obj: unknown, prefix = "", out: Set<string> = new Set()): Set<string> {
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === "object") flatten(value, path, out)
    else out.add(path)
  }
  return out
}

const VALID_KEYS = flatten(en)

function isI18nKey(key: string): boolean {
  return NAMESPACES.some((ns) => key === ns || key.startsWith(`${ns}.`))
}

function listSources(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listSources(full, acc)
    else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(full)
  }
  return acc
}

const T_CALL_RE = /\bt\(\s*["']([^"'\n]+)["']/g

function collectLiteralKeys(): Map<string, string[]> {
  const keyToFiles = new Map<string, string[]>()
  for (const file of listSources(TUI_ROOT)) {
    const source = readFileSync(file, "utf8")
    const rel = file.slice(TUI_ROOT.length + 1)
    for (const match of source.matchAll(T_CALL_RE)) {
      const key = match[1] as string
      if (!isI18nKey(key)) continue
      const files = keyToFiles.get(key) ?? []
      if (!files.includes(rel)) files.push(rel)
      keyToFiles.set(key, files)
    }
  }
  return keyToFiles
}

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

describe("i18n key resolution", () => {
  test('every literal t("…") key resolves in the English catalog', () => {
    const keyToFiles = collectLiteralKeys()
    expect(keyToFiles.size).toBeGreaterThan(0)

    const unresolved = [...keyToFiles.entries()]
      .filter(([key]) => !VALID_KEYS.has(key))
      .map(([key, files]) => `${key} (used in ${files.join(", ")})`)
      .sort()

    expect(unresolved).toEqual([])
  })

  test("every settings section id has a catalog label", () => {
    const unresolved = SECTIONS.map((s) => `settings.sections.${s.id}`).filter((key) => !VALID_KEYS.has(key))
    expect(unresolved).toEqual([])
  })

  test("every focus-accent slot has a catalog label", () => {
    const unresolved = UI_PREFS_FOCUS_ACCENT_SLOTS.map((slot) => `settings.general.accent${capitalize(slot)}`).filter(
      (key) => !VALID_KEYS.has(key),
    )
    expect(unresolved).toEqual([])
  })
})
