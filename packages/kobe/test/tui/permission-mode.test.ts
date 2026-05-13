import { describe, expect, test } from "vitest"
import { claudeCapabilities } from "../../src/engine/claude-code-local/capabilities.ts"
import { codexCapabilities } from "../../src/engine/codex-local/capabilities.ts"
import { permissionModeLabel } from "../../src/tui/panes/chat/composer/permission-mode.ts"

describe("permissionModeLabel", () => {
  test("uses engine-owned labels for Claude Code", () => {
    expect(permissionModeLabel(claudeCapabilities, undefined)).toBe("default")
    expect(permissionModeLabel(claudeCapabilities, "plan")).toBe("plan mode")
  })

  test("uses engine-owned labels for Codex", () => {
    expect(permissionModeLabel(codexCapabilities, undefined)).toBe("full access")
    expect(permissionModeLabel(codexCapabilities, "plan")).toBe("plan mode")
  })
})
