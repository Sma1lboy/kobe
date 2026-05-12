/**
 * Read codex's user config (`~/.codex/config.toml`) for the default
 * model.
 *
 * Codex stores per-user config in TOML, not JSON. We don't pull in a
 * TOML parser for one key — instead we grep for the top-level `model =
 * "..."` assignment. That's enough for "user pinned a default" without
 * depending on a TOML dialect we may parse wrong. Anything more nuanced
 * (profiles, nested overrides) we ignore for now; users with complex
 * configs already pin per-task via the picker.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CODEX_FALLBACK_DEFAULT_MODEL_ID } from "./models"

const CONFIG_PATH = join(homedir(), ".codex", "config.toml")

let cached: string | null | undefined

function readModelFromConfig(): string | null {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8")
    // Top-level only — skip lines that look like they're under a
    // [profile.<name>] table. Crude but sufficient for the common case.
    let inTable = false
    for (const line of raw.split("\n")) {
      const t = line.trim()
      if (t.startsWith("[") && t.endsWith("]")) {
        inTable = true
        continue
      }
      if (inTable) continue
      const m = /^model\s*=\s*"([^"]+)"/.exec(t)
      if (m) return m[1] ?? null
    }
    return null
  } catch {
    return null
  }
}

export function resolveCodexDefaultModelId(): string {
  if (cached === undefined) cached = readModelFromConfig()
  return cached ?? CODEX_FALLBACK_DEFAULT_MODEL_ID
}

export function _resetCodexSettingsCache(): void {
  cached = undefined
}
