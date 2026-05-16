import { ClaudeCodeLocal } from "./claude-code-local/index"
import { CodexLocal } from "./codex-local/index"
import { CopilotLocal } from "./copilot-local/index"
import { GeminiLocal } from "./gemini-local/index"
import type { EngineMap } from "./registry"

export function buildDefaultEngines(): EngineMap {
  return {
    claude: new ClaudeCodeLocal(),
    codex: new CodexLocal(),
    gemini: new GeminiLocal(),
    copilot: new CopilotLocal(),
  }
}
