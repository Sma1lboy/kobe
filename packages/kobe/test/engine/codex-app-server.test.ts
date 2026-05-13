import { buildAppServerArgs, codexAppServerUsageToSnapshot, resolveCodexBackend } from "@/engine/codex-local/app-server"
import { describe, expect, it } from "vitest"

describe("codex app-server backend helpers", () => {
  it("stays on exec unless explicitly enabled", () => {
    expect(resolveCodexBackend({} as NodeJS.ProcessEnv)).toBe("exec")
    expect(resolveCodexBackend({ KOBE_CODEX_BACKEND: "app-server" } as NodeJS.ProcessEnv)).toBe("app-server")
    expect(resolveCodexBackend({ KOBE_CODEX_APP_SERVER: "1" } as NodeJS.ProcessEnv)).toBe("app-server")
  })

  it("maps permission modes to app-server config args", () => {
    expect(buildAppServerArgs({ permissionMode: "default" })).toEqual([
      "app-server",
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="danger-full-access"',
    ])
    expect(buildAppServerArgs({ permissionMode: "plan" })).toEqual([
      "app-server",
      "-c",
      'approval_policy="never"',
      "-c",
      'sandbox_mode="read-only"',
    ])
  })

  it("normalizes official thread token usage into an exact EngineEvent usage snapshot", () => {
    expect(
      codexAppServerUsageToSnapshot({
        tokenUsage: {
          total: {
            totalTokens: 31_450,
            inputTokens: 31_445,
            cachedInputTokens: 21_888,
            outputTokens: 5,
            reasoningOutputTokens: 0,
          },
          last: {
            totalTokens: 31_450,
            inputTokens: 31_445,
            cachedInputTokens: 21_888,
            outputTokens: 5,
            reasoningOutputTokens: 0,
          },
          modelContextWindow: 258_400,
        },
      }),
    ).toEqual({
      type: "usage",
      input_tokens: 9557,
      cache_read_input_tokens: 21_888,
      output_tokens: 5,
      context_tokens: 31_450,
      context_window_tokens: 258_400,
    })
  })
})
