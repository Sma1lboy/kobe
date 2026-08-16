/**
 * Claude Code plugin takeover detection (issue #37, migration hard-gate).
 *
 * Once the user installs the Rove Claude Code plugin (`claude-plugin/` in this
 * repo, enabled as `rove@<marketplace>` in `~/.claude/settings.json`), the
 * plugin's own hooks.json + bundled skill carry the 12 activity hooks and the
 * SKILL.md. Two legacy installs then become DOUBLE registrations:
 *
 *   1. the settings.json activity-hook block kobe wrote on every launch
 *      (every event would fire twice → duplicate daemon reports), and
 *   2. a pre-plugin skill install under `~/.claude/skills/rove|kobe`
 *      (Claude Code loads both copies).
 *
 * The gate is PROMPT-ONLY by design: detection here never edits the user's
 * settings.json or deletes a skill directory. The one sanctioned cleanup path
 * is the explicit `rove hook cleanup` command (user-invoked), plus manually
 * removing the legacy skill directory. Vendor-specific (file location +
 * `enabledPlugins` schema are Claude Code's), hence this directory.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { hasKobeActivityHooks, isObject } from "../json-hooks.ts"
import { CLAUDE_HOOK_EVENT_MAP, claudeSettingsPath } from "./hook-adapter.ts"

/** The plugin name inside `claude-plugin/.claude-plugin/plugin.json`. An
 *  enabledPlugins key is `<plugin>@<marketplace>`; the marketplace half varies
 *  (git install vs local dev), so match on the plugin half only. */
const PLUGIN_NAME = "rove"

function readSettings(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** True when the Rove Claude Code plugin is installed AND enabled. */
export function isRovePluginEnabled(settingsFilePath: string = claudeSettingsPath()): boolean {
  const settings = readSettings(settingsFilePath)
  if (!settings || !isObject(settings.enabledPlugins)) return false
  return Object.entries(settings.enabledPlugins).some(([key, on]) => on === true && key.split("@")[0] === PLUGIN_NAME)
}

/** What the migration gate found — each entry is a double-registration risk. */
export interface MigrationFindings {
  /** settings.json still carries kobe's activity/worktree-watch hook groups. */
  readonly legacyHooks: boolean
  /** Pre-plugin skill directories Claude Code would load alongside the plugin's copy. */
  readonly legacySkillDirs: readonly string[]
}

export function detectLegacyInstalls(opts: { settingsFilePath?: string; home?: string } = {}): MigrationFindings {
  const settingsFilePath = opts.settingsFilePath ?? claudeSettingsPath()
  const home = opts.home ?? homedir()
  const settings = readSettings(settingsFilePath)
  // The worktree-watch hook shares the activity ownership predicate: its
  // command is `… hook worktree-created`, and "worktree-created" is not an
  // activity verb, so check it via its own marker substring.
  const legacyHooks =
    settings !== null && (hasKobeActivityHooks(settings, CLAUDE_HOOK_EVENT_MAP) || settingsHasWorktreeWatch(settings))
  const legacySkillDirs = ["rove", "kobe"]
    .map((name) => join(home, ".claude", "skills", name))
    .filter((dir) => existsSync(join(dir, "SKILL.md")))
  return { legacyHooks, legacySkillDirs }
}

function settingsHasWorktreeWatch(settings: Record<string, unknown>): boolean {
  const hooks = isObject(settings.hooks) ? settings.hooks : {}
  return Object.values(hooks).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some(
        (g) =>
          isObject(g) &&
          Array.isArray(g.hooks) &&
          g.hooks.some(
            (h) =>
              isObject(h) &&
              typeof h.command === "string" &&
              h.command.includes("worktree-created") &&
              // The plugin's own hook also contains the marker — only the
              // settings-managed one (kobe/rove invocation, no plugin root)
              // is legacy.
              !h.command.includes("CLAUDE_PLUGIN_ROOT"),
          ),
      ),
  )
}

/** The stderr notice for a detected double registration. Repeats every launch
 *  until cleaned — a double-firing hook set is an active misconfiguration,
 *  not a one-shot tip. Never edits anything. */
export function migrationHint(findings: MigrationFindings, cliName: string): string | null {
  if (!findings.legacyHooks && findings.legacySkillDirs.length === 0) return null
  const lines = [`${cliName}: the Rove Claude Code plugin is enabled, but legacy installs remain:`]
  if (findings.legacyHooks) {
    lines.push(
      "  • ~/.claude/settings.json still has the settings-managed Rove hooks (every event fires TWICE).",
      `    Run \`${cliName} hook cleanup\` to remove them (only Rove's own entries are touched).`,
    )
  }
  for (const dir of findings.legacySkillDirs) {
    lines.push(
      `  • legacy skill copy at ${dir} (the plugin bundles the skill — two copies double-register).`,
      `    Remove that directory to keep the plugin's copy only.`,
    )
  }
  lines.push("  Reading this inside a session? Just ask your agent to run the cleanup for you.")
  return `${lines.join("\n")}\n`
}
