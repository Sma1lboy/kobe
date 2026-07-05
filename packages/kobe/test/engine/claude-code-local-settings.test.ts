import { beforeEach, describe, expect, it, vi } from "vitest"

const readFileSyncMock = vi.fn<(...args: unknown[]) => string>()
vi.mock("node:fs", () => ({ readFileSync: (...args: unknown[]) => readFileSyncMock(...args) }))

import {
  CLAUDE_FALLBACK_DEFAULT_MODEL_ID,
  _resetClaudeSettingsCache,
  readClaudeSettings,
  resolveClaudeDefaultModelId,
} from "../../src/engine/claude-code-local/settings"

beforeEach(() => {
  _resetClaudeSettingsCache()
  readFileSyncMock.mockReset()
})

describe("readClaudeSettings", () => {
  it("returns the model when the settings file has a non-empty model string", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ model: "claude-x" }))
    expect(readClaudeSettings()).toEqual({ model: "claude-x" })
  })

  it("treats a missing/empty/non-string model as undefined", () => {
    for (const raw of [JSON.stringify({}), JSON.stringify({ model: "" }), JSON.stringify({ model: 7 })]) {
      _resetClaudeSettingsCache()
      readFileSyncMock.mockReturnValue(raw)
      expect(readClaudeSettings()).toEqual({ model: undefined })
    }
  })

  it("returns null when the parsed JSON is not an object", () => {
    readFileSyncMock.mockReturnValue("42")
    expect(readClaudeSettings()).toBeNull()
  })

  it("returns null when the file is absent or unreadable", () => {
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("nope"), { code: "ENOENT" })
    })
    expect(readClaudeSettings()).toBeNull()
  })

  it("caches the first read (no re-read on the second call)", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ model: "claude-x" }))
    readClaudeSettings()
    readClaudeSettings()
    expect(readFileSyncMock).toHaveBeenCalledTimes(1)
  })
})

describe("resolveClaudeDefaultModelId", () => {
  it("prefers the configured model", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({ model: "claude-cfg" }))
    expect(resolveClaudeDefaultModelId()).toBe("claude-cfg")
  })

  it("falls back to the hardcoded default when settings say nothing", () => {
    readFileSyncMock.mockReturnValue(JSON.stringify({}))
    expect(resolveClaudeDefaultModelId()).toBe(CLAUDE_FALLBACK_DEFAULT_MODEL_ID)
  })
})
