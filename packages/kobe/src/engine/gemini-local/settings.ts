import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export function resolveGeminiDefaultModelId(): string {
  const envModel = process.env.GEMINI_MODEL?.trim()
  if (envModel) return envModel

  try {
    const raw = readFileSync(path.join(homedir(), ".gemini", "settings.json"), "utf8")
    const parsed = JSON.parse(raw) as unknown
    if (isObject(parsed)) {
      const model = parsed.model
      if (typeof model === "string" && model.trim()) return model.trim()
      if (isObject(model) && typeof model.name === "string" && model.name.trim()) return model.name.trim()
    }
  } catch {
    /* fall through to CLI default */
  }

  return "auto"
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
