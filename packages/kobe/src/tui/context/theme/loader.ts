import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { kobeStateDir } from "../../../env"
import type { ThemeJson } from "../theme"
import { validateTheme } from "./schema"

export function userThemesDir(): string {
  return join(kobeStateDir(), "themes")
}

export type LoadedTheme = { name: string; theme: ThemeJson }

export function loadUserThemes(): LoadedTheme[] {
  const dir = userThemesDir()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }

  const out: LoadedTheme[] = []
  for (const file of entries) {
    if (!file.endsWith(".json")) continue
    const path = join(dir, file)
    let parsed: unknown
    try {
      const text = readFileSync(path, "utf8")
      parsed = JSON.parse(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[kobe] skipping user theme ${path}: invalid JSON — ${msg}`)
      continue
    }
    const result = validateTheme(parsed)
    if (!result.ok) {
      console.warn(`[kobe] skipping user theme ${path}: ${result.reason}`)
      continue
    }
    const name = file.slice(0, -".json".length)
    out.push({ name, theme: result.theme })
  }
  return out
}
