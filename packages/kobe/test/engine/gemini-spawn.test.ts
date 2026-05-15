import { buildArgs } from "@/engine/gemini-local/spawn"
import { describe, expect, it } from "vitest"

describe("gemini spawn args", () => {
  it("starts headless stream-json with yolo approval in default mode", () => {
    expect(
      buildArgs({
        binaryPath: "gemini",
        cwd: "/repo",
        prompt: "hello",
        model: "flash",
        permissionMode: "default",
      }),
    ).toEqual([
      "--output-format",
      "stream-json",
      "--skip-trust",
      "--model",
      "flash",
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
