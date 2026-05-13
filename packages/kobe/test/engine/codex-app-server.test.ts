import {
  buildAppServerArgs,
  codexAppServerItemNotificationToEvents,
  codexAppServerReasoningDeltaNotificationToEvent,
  codexAppServerUsageToSnapshot,
  resolveCodexBackend,
} from "@/engine/codex-local/app-server"
import { describe, expect, it } from "vitest"

describe("codex app-server backend helpers", () => {
  it("defaults to app-server and lets env/settings override it", () => {
    expect(resolveCodexBackend({} as NodeJS.ProcessEnv, () => undefined)).toBe("app-server")
    expect(resolveCodexBackend({ KOBE_CODEX_BACKEND: "exec" } as NodeJS.ProcessEnv, () => "app-server")).toBe("exec")
    expect(resolveCodexBackend({ KOBE_CODEX_BACKEND: "app-server" } as NodeJS.ProcessEnv, () => "exec")).toBe(
      "app-server",
    )
    expect(resolveCodexBackend({ KOBE_CODEX_APP_SERVER: "1" } as NodeJS.ProcessEnv, () => "exec")).toBe("app-server")
    expect(resolveCodexBackend({} as NodeJS.ProcessEnv, () => "exec")).toBe("exec")
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

  it("does not render transcript userMessage items as tool rows", () => {
    expect(
      codexAppServerItemNotificationToEvents("item/completed", {
        item: {
          id: "item-1",
          type: "userMessage",
          content: [{ type: "text", text: "how are you again" }],
        },
      }),
    ).toEqual([])
  })

  it("does not render empty reasoning items", () => {
    expect(
      codexAppServerItemNotificationToEvents("item/completed", {
        item: {
          id: "item-reasoning",
          type: "reasoning",
          summary: [],
          content: [],
        },
      }),
    ).toEqual([])
  })

  it("maps reasoning content to streamable reasoning text", () => {
    expect(
      codexAppServerItemNotificationToEvents("item/completed", {
        item: {
          id: "item-reasoning",
          type: "reasoning",
          summary: ["checked repo shape"],
          content: ["looked at daemon mode"],
        },
      }),
    ).toEqual([{ type: "reasoning.delta", text: "looked at daemon mode" }])
  })

  it("maps reasoning delta notifications to streamable reasoning text", () => {
    expect(
      codexAppServerReasoningDeltaNotificationToEvent("item/reasoning/summaryTextDelta", {
        itemId: "item-reasoning",
        delta: "checking ",
      }),
    ).toEqual({ type: "reasoning.delta", text: "checking " })
    expect(codexAppServerReasoningDeltaNotificationToEvent("item/reasoning/textDelta", { delta: "" })).toBeNull()
  })

  it("still maps real app-server tool items into tool events", () => {
    expect(
      codexAppServerItemNotificationToEvents("item/completed", {
        item: {
          id: "item-2",
          type: "commandExecution",
          command: "pwd",
          exitCode: 0,
        },
      }),
    ).toEqual([
      {
        type: "tool.result",
        name: "commandExecution",
        output: {
          command: "pwd",
          exitCode: 0,
        },
      },
    ])
  })
})
