import { describe, expect, it } from "vitest"
import {
  defaultEngineCommand,
  engineCommandKey,
  engineNameKey,
  parseEngineCommand,
} from "../../src/engine/interactive-command.ts"

describe("parseEngineCommand", () => {
  it("splits a bare binary name", () => {
    expect(parseEngineCommand("cl")).toEqual(["cl"])
  })

  it("splits a binary + flags on whitespace", () => {
    expect(parseEngineCommand("claude --model opus")).toEqual(["claude", "--model", "opus"])
  })

  it("keeps a quoted flag value with spaces as one argv element", () => {
    expect(parseEngineCommand('claude --append-system-prompt "be terse"')).toEqual([
      "claude",
      "--append-system-prompt",
      "be terse",
    ])
    expect(parseEngineCommand("codex --x 'a b c'")).toEqual(["codex", "--x", "a b c"])
  })

  it("collapses extra whitespace and ignores leading/trailing spaces", () => {
    expect(parseEngineCommand("  spaced   out ")).toEqual(["spaced", "out"])
  })

  it("returns [] for blank input", () => {
    expect(parseEngineCommand("")).toEqual([])
    expect(parseEngineCommand("   ")).toEqual([])
  })
})

describe("defaultEngineCommand", () => {
  it("maps each vendor to its bare interactive binary", () => {
    expect(defaultEngineCommand("claude")).toEqual(["claude"])
    expect(defaultEngineCommand("codex")).toEqual(["codex"])
  })

  it("falls back to claude for an undefined vendor", () => {
    expect(defaultEngineCommand(undefined)).toEqual(["claude"])
  })

  it("runs a custom engine id as a bare binary (not claude)", () => {
    expect(defaultEngineCommand("aider")).toEqual(["aider"])
  })
})

describe("engineCommandKey", () => {
  it("namespaces the override key per vendor", () => {
    expect(engineCommandKey("claude")).toBe("engineCommand.claude")
    expect(engineCommandKey("codex")).toBe("engineCommand.codex")
  })
})

describe("engineNameKey", () => {
  it("namespaces the display-name key per vendor, parallel to the command key", () => {
    expect(engineNameKey("claude")).toBe("engineName.claude")
    expect(engineNameKey("copilot")).toBe("engineName.copilot")
  })
})
