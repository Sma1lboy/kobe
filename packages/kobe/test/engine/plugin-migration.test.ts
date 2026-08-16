/**
 * Claude Code plugin takeover detection (`engine/claude-code-local/
 * plugin-migration.ts`) — the read-only side of the issue #37 migration
 * hard-gate. Everything here operates on temp files passed in explicitly;
 * nothing may touch the real ~/.claude (the gate's whole contract is that
 * detection never writes).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  detectLegacyInstalls,
  isRovePluginEnabled,
  migrationHint,
} from "../../src/engine/claude-code-local/plugin-migration.ts"

let home: string
let settingsPath: string

function writeSettings(settings: Record<string, unknown>): void {
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "kobe-plugmig-"))
  mkdirSync(join(home, ".claude"), { recursive: true })
  settingsPath = join(home, ".claude", "settings.json")
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

describe("isRovePluginEnabled", () => {
  it("matches rove@<any-marketplace> when enabled", () => {
    writeSettings({ enabledPlugins: { "rove@rove": true } })
    expect(isRovePluginEnabled(settingsPath)).toBe(true)
    writeSettings({ enabledPlugins: { "rove@local-dev": true } })
    expect(isRovePluginEnabled(settingsPath)).toBe(true)
  })

  it("ignores a disabled entry, other plugins, and prefix look-alikes", () => {
    writeSettings({ enabledPlugins: { "rove@rove": false, "ponytail@ponytail": true, "rover@x": true } })
    expect(isRovePluginEnabled(settingsPath)).toBe(false)
  })

  it("is false for a missing or unparsable settings file", () => {
    expect(isRovePluginEnabled(join(home, "nope.json"))).toBe(false)
    writeFileSync(settingsPath, "{oops")
    expect(isRovePluginEnabled(settingsPath)).toBe(false)
  })
})

describe("detectLegacyInstalls", () => {
  it("flags the settings-managed activity hooks", () => {
    writeSettings({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "'kobe' 'hook' 'turn-complete' '--engine' 'claude'" }] }] },
    })
    expect(detectLegacyInstalls({ settingsFilePath: settingsPath, home }).legacyHooks).toBe(true)
  })

  it("flags the settings-managed worktree-watch hook (not an activity verb)", () => {
    writeSettings({
      hooks: {
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "'kobe' 'hook' 'worktree-created'" }] }],
      },
    })
    expect(detectLegacyInstalls({ settingsFilePath: settingsPath, home }).legacyHooks).toBe(true)
  })

  it("does NOT flag the plugin's own hooks or unrelated user hooks", () => {
    writeSettings({
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "my-own-thing" }] }],
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: '"${CLAUDE_PLUGIN_ROOT}/bin/rove" hook worktree-created' }],
          },
        ],
      },
    })
    expect(detectLegacyInstalls({ settingsFilePath: settingsPath, home }).legacyHooks).toBe(false)
  })

  it("finds pre-plugin skill directories under ~/.claude/skills", () => {
    const dir = join(home, ".claude", "skills", "rove")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "SKILL.md"), "x")
    const found = detectLegacyInstalls({ settingsFilePath: settingsPath, home })
    expect(found.legacySkillDirs).toEqual([dir])
  })

  it("reports clean when nothing legacy exists", () => {
    writeSettings({})
    const found = detectLegacyInstalls({ settingsFilePath: settingsPath, home })
    expect(found.legacyHooks).toBe(false)
    expect(found.legacySkillDirs).toEqual([])
  })
})

describe("migrationHint", () => {
  it("is null when clean", () => {
    expect(migrationHint({ legacyHooks: false, legacySkillDirs: [] }, "rove")).toBeNull()
  })

  it("names the cleanup command for legacy hooks and the dir for legacy skills", () => {
    const hint = migrationHint({ legacyHooks: true, legacySkillDirs: ["/h/.claude/skills/rove"] }, "rove")
    expect(hint).toContain("rove hook cleanup")
    expect(hint).toContain("/h/.claude/skills/rove")
    // Prompt-only contract: the hint TELLS the user, it never claims to have
    // removed anything itself.
    expect(hint).not.toContain("removed")
  })
})
