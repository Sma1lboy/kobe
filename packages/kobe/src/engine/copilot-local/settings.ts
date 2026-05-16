import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { COPILOT_FALLBACK_DEFAULT_MODEL_ID } from "./models"

const SETTINGS_PATH = join(homedir(), ".copilot", "settings.json")

let cached: string | null | undefined

function stripJsonComments(raw: string): string {
  return raw
    .split("\n")
    .map((line) => line.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n")
}

function readModelFromSettings(): string | null {
  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(SETTINGS_PATH, "utf8"))) as unknown
    if (!isObject(parsed)) return null
    const model = parsed.model ?? parsed.defaultModel
    return typeof model === "string" && model.length > 0 ? model : null
  } catch {
    return null
  }
}

export function resolveCopilotDefaultModelId(): string {
  if (cached === undefined) cached = readModelFromSettings()
  return cached ?? COPILOT_FALLBACK_DEFAULT_MODEL_ID
}

export function _resetCopilotSettingsCache(): void {
  cached = undefined
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
