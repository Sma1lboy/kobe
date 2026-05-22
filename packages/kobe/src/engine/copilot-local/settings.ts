import { homedir } from "node:os"
import path from "node:path"

export const COPILOT_FALLBACK_DEFAULT_MODEL_ID = "auto"

export function copilotHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME?.trim() || path.join(homedir(), ".copilot")
}

export function resolveCopilotDefaultModelId(env: NodeJS.ProcessEnv = process.env): string {
  void env
  return COPILOT_FALLBACK_DEFAULT_MODEL_ID
}
