import { existsSync, readFileSync } from "node:fs"
import { keybindingsConfigPath } from "../env"

export type KeybindingsFile = {
  path: string
  exists: boolean
  doc: unknown
  warnings: string[]
}

let cached: KeybindingsFile | null = null

export function resetKeybindingsFileCache(): void {
  cached = null
}

function resolveConfigFile(): { canonical: string; found: string | null } {
  const canonical = keybindingsConfigPath()
  if (existsSync(canonical)) return { canonical, found: canonical }
  const yml = canonical.replace(/\.yaml$/, ".yml")
  if (existsSync(yml)) return { canonical, found: yml }
  return { canonical, found: null }
}

export function readKeybindingsFile(): KeybindingsFile {
  if (cached) return cached
  const { canonical, found } = resolveConfigFile()
  if (!found) {
    cached = { path: canonical, exists: false, doc: null, warnings: [] }
    return cached
  }
  const warnings: string[] = []
  let doc: unknown = null
  try {
    const text = readFileSync(found, "utf8")
    doc = Bun.YAML.parse(text)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    warnings.push(`could not read/parse ${found}: ${msg}`)
  }
  cached = { path: canonical, exists: true, doc, warnings }
  return cached
}
