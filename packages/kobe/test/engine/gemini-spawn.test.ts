import { GEMINI_MODELS } from "@/engine/gemini-local/models"
import { GEMINI_FALLBACK_DEFAULT_MODEL_ID } from "@/engine/gemini-local/settings"
import { buildArgs } from "@/engine/gemini-local/spawn"
import { describe, expect, it } from "vitest"

describe("gemini model catalog", () => {
  it("lists only explicit programmer-facing models", () => {
    expect(GEMINI_MODELS.map((m) => m.id)).toEqual([
      "gemini-3.1-pro-preview",
      "gemini-3-flash-preview",
      "gemini-2.5-pro",
    ])
    expect(GEMINI_FALLBACK_DEFAULT_MODEL_ID).toBe("gemini-3.1-pro-preview")
  })
})

describe("gemini spawn args", () => {
  it("starts headless stream-json with yolo approval in default mode", () => {
    expect(
      buildArgs({
        binaryPath: "gemini",
        cwd: "/repo",
        prompt: "hello",
        model: "gemini-3-flash-preview",
        permissionMode: "default",
      }),
    ).toEqual([
      "--output-format",
      "stream-json",
      "--skip-trust",
      "--model",
      "gemini-3-flash-preview",
      "--approval-mode",
      "yolo",
      "--prompt",
      "hello",
    ])
  })

  it("passes resume id and plan mode", () => {
    expect(
      buildArgs({
        binaryPath: "gemini",
        cwd: "/repo",
        prompt: "continue",
        resumeSessionId: "session-1",
        permissionMode: "plan",
      }),
    ).toContain("--resume")
    expect(
      buildArgs({
        binaryPath: "gemini",
        cwd: "/repo",
        prompt: "continue",
        resumeSessionId: "session-1",
        permissionMode: "plan",
      }),
    ).toContain("plan")
  })
})
