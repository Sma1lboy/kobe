/**
 * Engine-owned AI title generation helpers. These tests never call a real
 * model; the Codex generator is exercised through injected spawn deps.
 */

import { describe, expect, it } from "vitest"
import {
  buildCodexTitleCommand,
  codexTitleGenerator,
  generateCodexTitle,
} from "../../src/engine/codex-local/title-generator.ts"
import { engineEntry } from "../../src/engine/registry.ts"
import { NOOP_TITLE_GENERATOR, parseGeneratedTitleJson } from "../../src/engine/title-generator.ts"

describe("parseGeneratedTitleJson", () => {
  it("accepts a direct title object", () => {
    expect(parseGeneratedTitleJson('{"title":"Fix login button"}')).toBe("Fix login button")
  })

  it("accepts wrapped CLI json whose result is the title object", () => {
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

describe("buildCodexTitleCommand", () => {
  it("builds an ephemeral read-only exec invocation", () => {
    const command = buildCodexTitleCommand("gpt-5.3-codex", "Fix the login button", "/tmp/kobe-title.json")

    expect(command.argv.slice(0, 2)).toEqual(["codex", "exec"])
    expect(command.argv).toContain("--ephemeral")
    expect(command.argv).toContain("--ignore-rules")
    expect(command.argv).toContain("--ignore-user-config")
    expect(command.argv).toContain("--skip-git-repo-check")
    expect(command.argv).toContain("--sandbox")
    expect(command.argv).toContain("read-only")
    expect(command.argv).not.toContain("--ask-for-approval")
    expect(command.argv).toContain("--output-last-message")
    expect(command.argv).toContain("/tmp/kobe-title.json")
    expect(command.argv).toContain("--model")
    expect(command.argv).toContain("gpt-5.3-codex")
    expect(command.argv.at(-1)).toContain("Fix the login button")
  })
})

describe("generateCodexTitle", () => {
  it("returns the parsed title from the Codex last-message output file", async () => {
    const title = await generateCodexTitle("Fix the login button", {
      modelId: () => "gpt-5.3-codex",
      cwd: () => "/tmp",
      outputPath: () => "/tmp/kobe-title.json",
      readFile: async (path) => {
        expect(path).toBe("/tmp/kobe-title.json")
        return '{"title":"Fix login button"}'
      },
      spawn: async (argv) => {
        expect(argv).toContain("--ephemeral")
        expect(argv).toContain("--output-last-message")
        expect(argv).toContain("/tmp/kobe-title.json")
        return { exitCode: 0, stdout: "OpenAI Codex transcript noise", stderr: "" }
      },
    })

    expect(title).toBe("Fix login button")
  })

  it("returns null on command failure or invalid output", async () => {
    await expect(
      generateCodexTitle("Fix the login button", {
        modelId: () => "gpt-5.3-codex",
        cwd: () => "/tmp",
        outputPath: () => "/tmp/kobe-title.json",
        readFile: async () => '{"title":"Fix login button"}',
        spawn: async () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
      }),
    ).resolves.toBeNull()

    await expect(
      generateCodexTitle("Fix the login button", {
        modelId: () => "gpt-5.3-codex",
        cwd: () => "/tmp",
        outputPath: () => "/tmp/kobe-title.json",
        readFile: async () => "not json",
        spawn: async () => ({ exitCode: 0, stdout: "not json", stderr: "" }),
      }),
    ).resolves.toBeNull()
  })
})

describe("engine registry title generators", () => {
  it("wires Codex to a real title generator", async () => {
    expect(engineEntry("codex").titleGenerator).toBe(codexTitleGenerator)
  })

  it("leaves non-Codex engines on the fallback-only generator", async () => {
    expect(engineEntry("claude").titleGenerator).toBe(NOOP_TITLE_GENERATOR)
    expect(engineEntry("copilot").titleGenerator).toBe(NOOP_TITLE_GENERATOR)
    expect(engineEntry("custom-engine").titleGenerator).toBe(NOOP_TITLE_GENERATOR)
  })
})
