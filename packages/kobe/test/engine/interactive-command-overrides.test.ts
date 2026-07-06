import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  engineCommandKey,
  engineDisplayName,
  engineNameKey,
  interactiveEngineCommand,
  withClaudeSessionId,
  withEngineEffort,
} from "../../src/engine/interactive-command.ts"
import { setPersistedString } from "../../src/state/repos.ts"

let tmpHome: string
let originalHome: string | undefined

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-icmd-"))
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe("engineDisplayName", () => {
  it("uses the registry label when no override is persisted", () => {
    expect(engineDisplayName("claude")).toBe("Claude")
    expect(engineDisplayName("codex")).toBe("Codex")
  })

  it("prefers the persisted engineName override (trimmed)", () => {
    setPersistedString(engineNameKey("claude"), "  My Claude  ")
    expect(engineDisplayName("claude")).toBe("My Claude")
  })

  it("falls back to the id itself for a custom engine with no name set", () => {
    expect(engineDisplayName("aider")).toBe("aider")
  })
})

describe("interactiveEngineCommand", () => {
  it("returns the registry default when no override is persisted", () => {
    expect(interactiveEngineCommand("claude")).toEqual(["claude"])
    expect(interactiveEngineCommand(undefined)).toEqual(["claude"])
  })

  it("parses a persisted override string into argv (quotes preserved)", () => {
    setPersistedString(engineCommandKey("claude"), 'cl --append-system-prompt "be terse"')
    expect(interactiveEngineCommand("claude")).toEqual(["cl", "--append-system-prompt", "be terse"])
  })

  it("a whitespace-only override falls back to the built-in default", () => {
    setPersistedString(engineCommandKey("codex"), "   ")
    expect(interactiveEngineCommand("codex")).toEqual(["codex"])
  })

  it("weaves the codex reasoning-effort flag when a valid effort is passed", () => {
    expect(interactiveEngineCommand("codex", "high")).toEqual(["codex", "-c", "model_reasoning_effort=high"])
  })
})

describe("withEngineEffort", () => {
  it("appends -c model_reasoning_effort=<level> for codex", () => {
    expect(withEngineEffort(["codex"], "codex", "xhigh")).toEqual(["codex", "-c", "model_reasoning_effort=xhigh"])
  })

  it("drops an unknown level instead of passing it through (codex would refuse to launch)", () => {
    expect(withEngineEffort(["codex"], "codex", "turbo")).toEqual(["codex"])
  })

  it("ignores effort for vendors without a driveable flag, and blank/undefined effort", () => {
    expect(withEngineEffort(["claude"], "claude", "high")).toEqual(["claude"])
    expect(withEngineEffort(["claude"], undefined, "high")).toEqual(["claude"])
    expect(withEngineEffort(["codex"], "codex", "  ")).toEqual(["codex"])
    expect(withEngineEffort(["codex"], "codex", undefined)).toEqual(["codex"])
  })
})

describe("withClaudeSessionId", () => {
  it("appends a fresh --session-id <uuid> to a claude launch", () => {
    const { argv, sessionId } = withClaudeSessionId(["claude"], "claude")
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(argv).toEqual(["claude", "--session-id", sessionId])
  })

  it("defaults an undefined vendor to claude", () => {
    const { sessionId } = withClaudeSessionId(["claude"], undefined)
    expect(sessionId).not.toBeNull()
  })

  it("leaves non-claude vendors untouched", () => {
    expect(withClaudeSessionId(["codex"], "codex")).toEqual({ argv: ["codex"], sessionId: null })
  })

  it("never double-controls a session — a command with --resume/-c/--session-id wins", () => {
    for (const flag of ["--session-id", "--resume", "-r", "--continue", "-c", "--from-pr"]) {
      const argv = ["claude", flag, "x"]
      expect(withClaudeSessionId(argv, "claude")).toEqual({ argv, sessionId: null })
    }
  })
})
