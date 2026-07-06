import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json")

export type ClaudeSettings = {
  readonly model?: string
}

let cached: ClaudeSettings | null | undefined

export function readClaudeSettings(): ClaudeSettings | null {
  if (cached !== undefined) return cached
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object") {
      cached = null
      return null
    }
    const obj = parsed as Record<string, unknown>
    const model = typeof obj.model === "string" && obj.model.length > 0 ? obj.model : undefined
    cached = { model }
    return cached
  } catch {
    cached = null
    return null
  }
}

export function _resetClaudeSettingsCache(): void {
  cached = undefined
}

export const CLAUDE_FALLBACK_DEFAULT_MODEL_ID = "claude-opus-4-7[1m]"

export function resolveClaudeDefaultModelId(): string {
  const settings = readClaudeSettings()
  if (settings?.model && settings.model.length > 0) return settings.model
  return CLAUDE_FALLBACK_DEFAULT_MODEL_ID
}
