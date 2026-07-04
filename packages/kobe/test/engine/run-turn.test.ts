import { describe, expect, it } from "vitest"
import {
  runTurnEffortKey,
  runTurnModelKey,
  runTurnSettingsFromState,
  runTurnSmallModelKey,
} from "../../src/engine/run-turn-settings.ts"
import { buildCodexExecArgs, parseCodexExecJsonLine, resolveRunTurnModel } from "../../src/engine/run-turn/codex.ts"

describe("buildCodexExecArgs", () => {
  it("builds a noninteractive JSONL codex exec command for a worktree", () => {
    expect(
      buildCodexExecArgs({
        prompt: "summarize this repo",
        worktree: "/repo/kobe",
        model: "gpt-test",
        effort: "low",
      }),
    ).toEqual([
      "exec",
      "--json",
      "-C",
      "/repo/kobe",
      "-m",
      "gpt-test",
      "-c",
      "model_reasoning_effort=low",
      "-s",
      "workspace-write",
      "-a",
      "never",
      "summarize this repo",
    ])
  })

  it("drops unsupported effort levels instead of passing a bad codex flag", () => {
    expect(
      buildCodexExecArgs({
        prompt: "hi",
        worktree: "/repo/kobe",
        effort: "bogus",
      }),
    ).toEqual(["exec", "--json", "-C", "/repo/kobe", "-s", "workspace-write", "-a", "never", "hi"])
  })

  it("can build an ephemeral small-model probe", () => {
    expect(
      buildCodexExecArgs({
        prompt: "pick the right model",
        worktree: "/repo/kobe",
        model: "small-test",
        ephemeral: true,
        sandbox: "read-only",
      }),
    ).toEqual([
      "exec",
      "--json",
      "-C",
      "/repo/kobe",
      "-m",
      "small-test",
      "-s",
      "read-only",
      "-a",
      "never",
      "--ephemeral",
      "pick the right model",
    ])
  })
})

describe("parseCodexExecJsonLine", () => {
  it("extracts assistant text from codex response_item messages", () => {
    expect(
      parseCodexExecJsonLine(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
          },
        }),
      ),
    ).toEqual([{ type: "assistant_text", text: "done" }])
  })

  it("extracts reasoning text and response output deltas", () => {
    expect(
      parseCodexExecJsonLine(
        JSON.stringify({
          type: "response_item",
          payload: {
            type: "reasoning",
            summary: [{ text: "checking files" }],
          },
        }),
      ),
    ).toEqual([{ type: "reasoning", text: "checking files" }])

    expect(parseCodexExecJsonLine(JSON.stringify({ type: "response.output_text.delta", delta: "hi" }))).toEqual([
      { type: "assistant_text", text: "hi" },
    ])
  })

  it("ignores malformed or irrelevant JSONL", () => {
    expect(parseCodexExecJsonLine("not json")).toEqual([])
    expect(parseCodexExecJsonLine(JSON.stringify({ type: "turn.completed" }))).toEqual([
      { type: "turn_completed", usage: undefined },
    ])
  })
})

describe("runTurn settings", () => {
  it("namespaces model, small-model, and effort per vendor", () => {
    expect(runTurnModelKey("codex")).toBe("runTurnModel.codex")
    expect(runTurnSmallModelKey("codex")).toBe("runTurnSmallModel.codex")
    expect(runTurnEffortKey("codex")).toBe("runTurnEffort.codex")
  })

  it("reads valid configured runTurn settings from a state snapshot", () => {
    const state = {
      [runTurnModelKey("codex")]: "gpt-large",
      [runTurnSmallModelKey("codex")]: "gpt-small",
      [runTurnEffortKey("codex")]: "medium",
    }
    expect(runTurnSettingsFromState(state, "codex")).toEqual({
      model: "gpt-large",
      smallModel: "gpt-small",
      effort: "medium",
      effortLevels: ["none", "low", "medium", "high", "xhigh"],
    })
  })

  it("keeps the small-model selection separate from the default runTurn model", () => {
    const state = {
      [runTurnModelKey("codex")]: "gpt-large",
      [runTurnSmallModelKey("codex")]: "gpt-small",
    }
    const settings = runTurnSettingsFromState(state, "codex")

    expect(resolveRunTurnModel({ explicitModel: undefined, purpose: "default", settings })).toBe("gpt-large")
    expect(resolveRunTurnModel({ explicitModel: undefined, purpose: "small", settings })).toBe("gpt-small")
    expect(resolveRunTurnModel({ explicitModel: "override", purpose: "small", settings })).toBe("override")
  })
})
