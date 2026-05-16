import { COPILOT_FALLBACK_DEFAULT_MODEL_ID, COPILOT_MODELS } from "@/engine/copilot-local/models"
import { buildArgs } from "@/engine/copilot-local/spawn"
import { describe, expect, it } from "vitest"

describe("copilot model catalog", () => {
  it("lists Copilot-hosted models with a conservative fallback", () => {
    expect(COPILOT_MODELS.map((m) => m.id)).toEqual([
      "auto",
      "gpt-5.2",
      "gpt-5.2",
      "gpt-5.2",
      "gpt-5.2",
      "gpt-5.2",
      "gpt-5-mini",
      "claude-sonnet-4.6",
    ])
    expect(COPILOT_FALLBACK_DEFAULT_MODEL_ID).toBe("gpt-5-mini")
  })
})

describe("copilot spawn args", () => {
  it("starts prompt-mode JSONL with a kobe-owned session id", () => {
    expect(
      buildArgs({
        binaryPath: "copilot",
        cwd: "/repo",
        prompt: "hello",
        sessionId: "00000000-0000-4000-8000-000000000000",
        model: "gpt-5.2",
        permissionMode: "default",
      }),
    ).toEqual([
      "-C",
      "/repo",
      "--resume",
      "00000000-0000-4000-8000-000000000000",
      "--output-format",
      "json",
      "--stream",
      "on",
      "--no-auto-update",
      "--no-ask-user",
      "--model",
      "gpt-5.2",
      "--allow-all",
      "-p",
      "hello",
    ])
  })

  it("maps plan mode and supported reasoning effort to Copilot flags", () => {
    const args = buildArgs({
      binaryPath: "copilot",
      cwd: "/repo",
      prompt: "plan",
      sessionId: "session-1",
      modelEffort: "high",
      permissionMode: "plan",
    })

    expect(args).toContain("--reasoning-effort")
    expect(args).toContain("high")
    expect(args).toContain("--mode")
    expect(args).toContain("plan")
    expect(args).not.toContain("--allow-all")
  })
})
