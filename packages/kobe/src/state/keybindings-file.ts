/**
 * Shared reader for `~/.kobe/settings/keybindings.yaml`.
 *
 * The framework-free reader lives here so config IO remains separate from
 * the keymap mutation performed by `tui/context/keybindings-user.ts`.
 *
 * Read once per process and cached: the TUI applies keybindings at boot
 * and the daemon watcher explicitly clears this cache for live reloads.
 */

import { existsSync, readFileSync } from "node:fs"
import { errorMessage } from "@/lib/error-message"
import { keybindingsConfigPath } from "../env"

export type KeybindingsFile = {
  /** Canonical config path (the `.yaml` spelling, even when `.yml` was read). */
  path: string
  /** Whether a config file was found at all. */
  exists: boolean
  /** Parsed YAML document, or null when missing/unparseable. */
  doc: unknown
  /** Read/parse-level problems (NOT per-binding validation). */
  warnings: string[]
}

let cached: KeybindingsFile | null = null

/**
 * Drop the cached read so the next {@link readKeybindingsFile} hits disk
 * again. Used by the live-reload path (`reloadUserKeybindings`) when the
 * daemon's keybindings watcher reports the file changed; the boot read is
 * otherwise "once per process".
 */
export function resetKeybindingsFileCache(): void {
  cached = null
}

/** Resolve the config file, accepting `.yml` when `.yaml` is absent. */
function resolveConfigFile(): { canonical: string; found: string | null } {
  const canonical = keybindingsConfigPath()
  if (existsSync(canonical)) return { canonical, found: canonical }
  const yml = canonical.replace(/\.yaml$/, ".yml")
  if (existsSync(yml)) return { canonical, found: yml }
  return { canonical, found: null }
}

/** Read + parse the keybindings YAML once; never throws. */
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
    const msg = errorMessage(err)
    warnings.push(`could not read/parse ${found}: ${msg}`)
  }
  cached = { path: canonical, exists: true, doc, warnings }
  return cached
}
