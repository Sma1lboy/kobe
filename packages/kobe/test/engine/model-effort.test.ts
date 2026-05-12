import { describe, expect, test } from "vitest"
import { buildArgs as buildClaudeArgs } from "../../src/engine/claude-code-local/spawn"
import { buildArgs as buildCodexArgs } from "../../src/engine/codex-local/spawn"

describe("model-bound effort spawn args", () => {
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
