import { describe, expect, test } from "vitest"
import { CLAUDE_MODELS } from "../../src/engine/claude-code-local/models"
import { buildArgs as buildClaudeArgs } from "../../src/engine/claude-code-local/spawn"
import { CODEX_MODELS } from "../../src/engine/codex-local/models"
import { buildArgs as buildCodexArgs } from "../../src/engine/codex-local/spawn"

describe("model-bound effort spawn args", () => {
  test("catalog exposes only efforts accepted by each engine's current CLI path", () => {
    const claudeEfforts = new Set(CLAUDE_MODELS.flatMap((m) => (m.effort ? [m.effort] : [])))
    const codexEfforts = new Set(CODEX_MODELS.flatMap((m) => (m.effort ? [m.effort] : [])))

    expect([...claudeEfforts].sort()).toEqual(["high", "low", "max", "medium", "xhigh"])
    // `minimal` is intentionally absent: current codex exec keeps web
    // search/image tools enabled, and the API rejects minimal effort
    // with that tool set.
    expect([...codexEfforts].sort()).toEqual(["high", "low", "medium", "none", "xhigh"])
  })

  test("all claude effort catalog choices forward through --effort", () => {
    const choices = CLAUDE_MODELS.filter((m) => m.effort)
    expect(choices.length).toBeGreaterThan(0)

    for (const choice of choices) {
      const args = buildClaudeArgs({
        binaryPath: "/bin/claude",
        cwd: "/tmp/repo",
        prompt: "work",
        model: choice.id,
        modelEffort: choice.effort,
      })

      expect(args).toContain("--effort")
      expect(args).toContain(choice.effort)
    }
  })

  test("all codex effort catalog choices forward through model_reasoning_effort config", () => {
    const choices = CODEX_MODELS.filter((m) => m.effort)
    expect(choices.length).toBeGreaterThan(0)

    for (const choice of choices) {
      const args = buildCodexArgs({
        binaryPath: "/bin/codex",
        cwd: "/tmp/repo",
        prompt: "work",
        model: choice.id,
        modelEffort: choice.effort,
      })

      expect(args).toContain(`model_reasoning_effort="${choice.effort}"`)
    }
  })

  test("claude forwards model effort through --effort", () => {
    expect(
      buildClaudeArgs({
        binaryPath: "/bin/claude",
        cwd: "/tmp/repo",
        prompt: "work",
        model: "claude-opus-4-7[1m]",
        modelEffort: "max",
      }),
    ).toContain("--effort")
    expect(
      buildClaudeArgs({
        binaryPath: "/bin/claude",
        cwd: "/tmp/repo",
        prompt: "work",
        model: "claude-opus-4-7[1m]",
        modelEffort: "max",
      }),
    ).toContain("max")
  })

  test("codex forwards model effort through model_reasoning_effort config", () => {
    expect(
      buildCodexArgs({
        binaryPath: "/bin/codex",
        cwd: "/tmp/repo",
        prompt: "work",
        model: "gpt-5.5",
        modelEffort: "xhigh",
      }),
    ).toContain('model_reasoning_effort="xhigh"')
  })
})
