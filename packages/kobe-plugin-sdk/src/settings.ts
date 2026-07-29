/**
 * Read the plugin's `[[settings]]` values — plain KEY=value lines in
 * `$KOBE_PLUGIN_CONFIG_DIR/.env`, the same file the Settings → Plugins
 * editors write. Values are strings; booleans store "1" or are absent.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

export function readSettings(configDir: string): Record<string, string> {
  let text: string
  try {
    text = readFileSync(join(configDir, ".env"), "utf8")
  } catch {
    return {}
  }
  const out: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m) out[m[1] as string] = m[2] as string
  }
  return out
}

/** One setting with a fallback — `setting(dir, "MODE", "fast")`. */
export function setting(configDir: string, key: string, fallback = ""): string {
  return readSettings(configDir)[key] ?? fallback
}
