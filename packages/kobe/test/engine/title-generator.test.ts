/**
 * Engine-owned AI title generation helpers. These tests never call a real
 * model; the Claude generator is exercised through injected spawn deps.
 */

import { describe, expect, it } from "vitest"
import {
  TITLE_JSON_SCHEMA,
  buildClaudeTitleCommand,
  generateClaudeTitle,
} from "../../src/engine/claude-code-local/title-generator.ts"
import { parseGeneratedTitleJson } from "../../src/engine/title-generator.ts"

describe("parseGeneratedTitleJson", () => {
  it("accepts a direct title object", () => {
    expect(parseGeneratedTitleJson('{"title":"Fix login button"}')).toBe("Fix login button")
  })

  it("accepts Claude print json whose result is the title object", () => {
    expect(parseGeneratedTitleJson('{"type":"result","result":"{\\"title\\":\\"Fix login button\\"}"}')).toBe(
      "Fix login button",
    )
  })

  it("rejects empty, multiline, and overlong titles", () => {
    expect(parseGeneratedTitleJson('{"title":""}')).toBeNull()
    expect(parseGeneratedTitleJson('{"title":"Line one\\nLine two"}')).toBeNull()
    expect(parseGeneratedTitleJson(JSON.stringify({ title: "x".repeat(81) }))).toBeNull()
  })
})

describe("buildClaudeTitleCommand", () => {
  it("builds a non-persistent structured-output print invocation", () => {
    const command = buildClaudeTitleCommand("claude-haiku-test", "Fix the login button")

    expect(command.argv.slice(0, 2)).toEqual(["claude", "-p"])
    expect(command.argv).toContain("--no-session-persistence")
    expect(command.argv).toContain("--output-format")
    expect(command.argv).toContain("json")
    expect(command.argv).toContain("--json-schema")
    expect(command.argv).toContain(JSON.stringify(TITLE_JSON_SCHEMA))
    expect(command.argv).toContain("--model")
    expect(command.argv).toContain("claude-haiku-test")
    expect(command.argv.at(-1)).toBe("Fix the login button")
  })
})

describe("generateClaudeTitle", () => {
  it("returns the parsed title from injected command output", async () => {
    const title = await generateClaudeTitle("Fix the login button", {
      modelId: () => "claude-haiku-test",
      cwd: () => "/tmp",
      spawn: async (argv) => {
        expect(argv).toContain("--no-session-persistence")
        return { exitCode: 0, stdout: '{"result":"{\\"title\\":\\"Fix login button\\"}"}', stderr: "" }
      },
    })

    expect(title).toBe("Fix login button")
  })

  it("returns null on command failure or invalid output", async () => {
    await expect(
      generateClaudeTitle("Fix the login button", {
        modelId: () => "claude-haiku-test",
        cwd: () => "/tmp",
        spawn: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
      }),
    ).resolves.toBeNull()

    await expect(
      generateClaudeTitle("Fix the login button", {
        modelId: () => "claude-haiku-test",
        cwd: () => "/tmp",
        spawn: async () => ({ exitCode: 0, stdout: '{"title":""}', stderr: "" }),
      }),
    ).resolves.toBeNull()
  })
})
