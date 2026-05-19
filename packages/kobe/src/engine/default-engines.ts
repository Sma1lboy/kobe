import { ClaudeCodeLocal } from "./claude-code-local/index"
import { CodexLocal } from "./codex-local/index"
import { GeminiLocal } from "./gemini-local/index"
import { InteractiveClaudeEngine } from "./interactive-claude/index"
import type { EngineMap } from "./registry"

/**
 * Build the per-vendor engine map the orchestrator routes through.
 *
 * The `claude` slot is `ClaudeCodeLocal` (the `claude -p` subprocess
 * engine) by default. Setting `KOBE_INTERACTIVE_CLAUDE=1` opts the
 * `claude` slot into {@link InteractiveClaudeEngine} instead — the
 * KOB-208 engine that drives an interactive `claude` REPL so usage
 * stays on the Claude subscription. It is opt-in, not the default:
 * choosing kobe's default engine is a separate decision.
 */
export function buildDefaultEngines(): EngineMap {
  const useInteractiveClaude = process.env.KOBE_INTERACTIVE_CLAUDE === "1"
  return {
    claude: useInteractiveClaude ? new InteractiveClaudeEngine() : new ClaudeCodeLocal(),
    codex: new CodexLocal(),
    gemini: new GeminiLocal(),
  }
}
