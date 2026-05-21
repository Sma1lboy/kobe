import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const COPILOT_FALLBACK_DEFAULT_MODEL_ID = "auto"

export function copilotHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME?.trim() || path.join(homedir(), ".copilot")
}

export function resolveCopilotDefaultModelId(env: NodeJS.ProcessEnv = process.env): string {
  const envModel = env.COPILOT_MODEL?.trim()
  if (envModel) return envModel
  for (const file of ["settings.json", "config.json"]) {
    try {
      const raw = readFileSync(path.join(copilotHomeDir(env), file), "utf8")
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const model = (parsed as Record<string, unknown>).model
        if (typeof model === "string" && model.trim()) return model.trim()
      }
    } catch {
      /* settings are advisory; fall through to the documented auto model */
    }
  }
  return COPILOT_FALLBACK_DEFAULT_MODEL_ID
}
