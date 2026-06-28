/**
 * CI guard: every i18n key referenced in source resolves in the catalog.
 *
 * The parity gate (`i18n-catalog.test.ts`) only checks that `en` and every
 * other locale agree with EACH OTHER. It cannot catch a `t("foo.bar")` added
 * to code whose key is missing from BOTH catalogs: parity still passes (both
 * sides lack it equally), yet `t()` falls back to the raw dotted key and the
 * UI renders `foo.bar` literally — the exact silent failure the i18n runtime's
 * fallback is meant to make loud, surfaced one layer too late (at runtime, in
 * front of the user, instead of in CI).
 *
 * This scans `src/tui/**` for the i18n call sites and fails on any key that
 * doesn't resolve in English:
 *   - literal `t("…")` / `t('…')` calls, and
 *   - the two enumerable dynamic `t()` template families
 *     (`settings.sections.<id>` and `settings.general.accent<Slot>`), checked
 *     against their runtime value sets so a new section / accent slot can't
 *     ship a key with no catalog entry.
 *
 * Out of scope (no static key to check): `tKeys("category"|"desc", id)` is only
 * ever called with a dynamic keybinding id, so its coverage rides on the
 * keybinding catalog rather than this scan.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { SECTIONS } from "../../src/tui/component/settings-dialog/model"
import { en } from "../../src/tui/i18n/catalog"
import { UI_PREFS_FOCUS_ACCENT_SLOTS } from "../../src/tui/lib/apply-ui-prefs"

const TUI_ROOT = fileURLToPath(new URL("../../src/tui", import.meta.url))

/** Top-level catalog namespaces — a literal `t()` key starting with one of
 *  these is unambiguously an i18n key (and not some other `t(`-shaped call). */
const NAMESPACES = Object.keys(en)

/** Flatten a nested message object into dotted `a.b.c` keys. */
function flatten(obj: unknown, prefix = "", out: Set<string> = new Set()): Set<string> {
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value && typeof value === "object") flatten(value, path, out)
    else out.add(path)
  }
  return out
}

const VALID_KEYS = flatten(en)

/** Whether a captured literal looks like an i18n key (vs. an unrelated `t(`). */
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

/** Capture the first string-literal argument of every `t("…")` / `t('…')`
 *  call. `\bt\(` ignores `tKeys(` (no `t(` boundary) and `format(` (`t` mid-word). */
const T_CALL_RE = /\bt\(\s*["']([^"'\n]+)["']/g

/** Every literal i18n key referenced under `src/tui`, with the files using it. */
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
    expect(keyToFiles.size).toBeGreaterThan(0) // the scan actually found call sites

    const unresolved = [...keyToFiles.entries()]
      .filter(([key]) => !VALID_KEYS.has(key))
      .map(([key, files]) => `${key} (used in ${files.join(", ")})`)
      .sort()

    expect(unresolved).toEqual([])
  })

  // `settings.sections.${s.id}` in settings-dialog/sections.tsx.
  test("every settings section id has a catalog label", () => {
    const unresolved = SECTIONS.map((s) => `settings.sections.${s.id}`).filter((key) => !VALID_KEYS.has(key))
    expect(unresolved).toEqual([])
  })

  // `settings.general.accent${Slot}` in settings-dialog/sections.tsx.
  test("every focus-accent slot has a catalog label", () => {
    const unresolved = UI_PREFS_FOCUS_ACCENT_SLOTS.map((slot) => `settings.general.accent${capitalize(slot)}`).filter(
      (key) => !VALID_KEYS.has(key),
    )
    expect(unresolved).toEqual([])
  })
})
