/**
 * Read claude-code's user settings file (`~/.claude/settings.json`).
 *
 * Mirrors how claude-code itself resolves the default model in
 * `refs/claude-code/src/utils/model/model.ts:getUserSpecifiedModelSetting()`:
 * the file's top-level `model` key (when present) wins over our hardcoded
 * fallback. The JSON has many other fields we don't care about — we read
 * just `model` for now.
 *
 *   const settings = readClaudeSettings()
 *   const default = settings?.model ?? FALLBACK_MODEL_ID
 *
 * Why match claude-code's path verbatim — `~/.claude/settings.json` —
 * rather than persisting a kobe-only override: kobe wraps `claude -p`,
 * so when the user has already configured claude-code (via the CLI's own
 * `/model` command, which writes to this same file), kobe should honor
 * that pick instead of asking again. Same goes for environment-managed
 * pins (a workplace policy file at this path).
 *
 * Reads are best-effort: missing file, malformed JSON, permission errors
 * all collapse to `null`. Caller falls back to the hardcoded default. We
 * deliberately do NOT throw — a broken settings file shouldn't take down
 * kobe's startup.
 *
 * Cached for the process lifetime — claude-code rewrites the file on
 * `/model` runs, but kobe only reads on task spawn / picker mount and
 * a stale read between mutations is acceptable. The cache means we
 * don't fs-stat on every render.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** Path matches claude-code's `getSettings_DEPRECATED()` location. */
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json")

/**
 * Subset of the claude-code settings shape we consume. Mirrors the
 * relevant fields from `refs/claude-code/src/utils/settings/types.ts`.
 * Stays narrow on purpose — we only read what we forward to the engine.
 */
export type ClaudeSettings = {
  /** Model id override, e.g. `"claude-opus-4-7"` or `"claude-opus-4-7[1m]"`. */
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

/**
 * Drop the read cache. Tests hit this between fixtures; production code
 * should not need it (claude-code rewriting `~/.claude/settings.json`
 * during a kobe session and us picking that up live is a follow-up).
 */
export function _resetClaudeSettingsCache(): void {
  cached = undefined
}

/**
 * Hardcoded fallback model — used when neither a per-task pin NOR the
 * user's claude-code `~/.claude/settings.json` `model` key supplies one.
 * Opus 4.7 1M context: kobe-preferred default for new sessions because
 * the long-context variant lines up best with kobe's "task = a worktree
 * of sustained work" model, where conversations grow large.
 *
 * Lives here (not in the composer's `models.ts`) so the orchestrator
 * can import it without dragging Solid / opentui into a non-UI module.
 */
export const FALLBACK_DEFAULT_MODEL_ID = "claude-opus-4-7[1m]"

/**
 * Resolve the model id to use when a task has no explicit pin.
 * Mirrors claude-code's `getUserSpecifiedModelSetting()` ordering:
 *
 *   1. `~/.claude/settings.json` `model` key.
 *   2. {@link FALLBACK_DEFAULT_MODEL_ID}.
 *
 * Caller should still check `Task.model` BEFORE invoking this — that
 * pin overrides everything.
 */
export function resolveDefaultModelId(): string {
  const settings = readClaudeSettings()
  if (settings?.model && settings.model.length > 0) return settings.model
  return FALLBACK_DEFAULT_MODEL_ID
}
