import { findCopilotBinary } from "@/engine/copilot-local/binary"
import { parseEvents, parseWorkspaceYaml } from "@/engine/copilot-local/history"
import { COPILOT_MODELS } from "@/engine/copilot-local/models"
import { resolveCopilotDefaultModelId } from "@/engine/copilot-local/settings"
import { buildArgs, buildSpawnCommand } from "@/engine/copilot-local/spawn"
import { copilotUsageToSnapshot, parseCopilotJson } from "@/engine/copilot-local/stream"
import { describe, expect, it } from "vitest"

async function collect(lines: string[]) {
  const out = []
  for await (const ev of parseCopilotJson(lineSource(lines))) out.push(ev)
  return out
}

async function* lineSource(lines: string[]): AsyncIterable<string> {
  for (const line of lines) yield line
}

describe("copilot spawn args", () => {
  it("starts programmatic JSON streaming with full access in default mode", () => {
    expect(
      buildArgs({
        binaryPath: "copilot",
        cwd: "/repo",
        prompt: "hello",
        model: "gpt-5-mini",
        permissionMode: "default",
      }),
    ).toEqual([
      "-C",
      "/repo",
      "--output-format",
      "json",
      "--stream",
      "on",
      "--no-color",
      "--no-remote",
      "--no-ask-user",
      "--model",
      "gpt-5-mini",
      "--allow-all",
      "--prompt",
      "hello",
    ])
  })

  it("passes uuid session id and plan mode", () => {
    const args = buildArgs({
      binaryPath: "copilot",
      cwd: "/repo",
      prompt: "continue",
      sessionId: "8970f69d-034e-4cb8-9d34-829ed0d2404d",
      permissionMode: "plan",
      modelEffort: "high",
    })
    expect(args).toContain("--session-id=8970f69d-034e-4cb8-9d34-829ed0d2404d")
    expect(args).toContain("--mode")
    expect(args).toContain("plan")
    expect(args).toContain("--effort")
    expect(args).toContain("high")
  })

  it("falls back to resume for legacy non-uuid session ids", () => {
    const args = buildArgs({
      binaryPath: "copilot",
      cwd: "/repo",
      prompt: "continue",
      sessionId: "session-name",
    })

    expect(args).toContain("--resume=session-name")
  })

  it("does not pass unavailable legacy Copilot model ids", () => {
    expect(
      buildArgs({
        binaryPath: "copilot",
        cwd: "/repo",
        prompt: "hello",
        model: "gpt-5.3-codex",
        permissionMode: "default",
      }),
    ).not.toContain("--model")
  })

  it("keeps unavailable Copilot plan-gated models out of the picker catalog", () => {
    expect(COPILOT_MODELS.map((m) => m.id)).not.toContain("gpt-5.3-codex")
  })

  it("lets the Copilot CLI own configured default model resolution", () => {
    expect(resolveCopilotDefaultModelId({ COPILOT_MODEL: "gpt-5.3-codex" })).toBe("auto")
  })

  it("launches Windows npm command shims through cmd.exe", () => {
    const command = buildSpawnCommand(
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\copilot.cmd",
      ["--prompt", "hello & keep %PATH% literal"],
      "win32",
    )

    expect(command.file).toBe("cmd.exe")
    expect(command.args).toEqual([
      "/d",
      "/s",
      "/c",
      '"C:\\Users\\dev\\AppData\\Roaming\\npm\\copilot.cmd" "--prompt" "hello & keep %%PATH%% literal"',
    ])
  })
})

describe("copilot binary discovery", () => {
  it("falls back to the Windows npm .cmd shim", async () => {
    const existing = "C:\\Users\\dev\\AppData\\Roaming/npm/copilot.cmd"
    await expect(
      findCopilotBinary({
        fileExists: (p) => p === existing,
        env: (name) => (name === "APPDATA" ? "C:\\Users\\dev\\AppData\\Roaming" : undefined),
        home: () => "C:\\Users\\dev",
        which: () => undefined,
        platform: () => "win32",
      }),
    ).resolves.toBe(existing)
  })
})

describe("copilot JSON stream parser", () => {
  it("normalizes session, assistant deltas, tool calls, usage, and done", async () => {
    let sessionId = ""
    const events = []
    for await (const ev of parseCopilotJson(
      lineSource([
        JSON.stringify({ type: "session.start", data: { sessionId: "sid-1" } }),
        JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "hi" } }),
        JSON.stringify({
          type: "tool.execution_start",
          data: { toolCallId: "tool-1", toolName: "bash", arguments: { command: "git status" } },
        }),
        JSON.stringify({
          type: "tool.execution_complete",
          data: { toolCallId: "tool-1", success: true, result: { content: "clean" } },
        }),
        JSON.stringify({
          type: "result",
          exitCode: 0,
          usage: {
            modelMetrics: { "gpt-5-mini": { usage: { inputTokens: 10, outputTokens: 3, cacheReadTokens: 2 } } },
            currentTokens: 20,
          },
        }),
      ]),
      {
        onSessionId: (sid) => {
          sessionId = sid
        },
      },
    )) {
      events.push(ev)
    }
    expect(sessionId).toBe("sid-1")
    expect(events).toEqual([
      { type: "assistant.delta", text: "hi" },
      { type: "tool.start", name: "bash", input: { command: "git status" }, id: "tool-1" },
      { type: "tool.result", name: "bash", output: { content: "clean" } },
      { type: "usage", input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2, context_tokens: 20 },
      { type: "done" },
    ])
  })

  it("surfaces malformed JSON as an error event", async () => {
    const events = await collect(["{ nope"])
    expect(events[0]?.type).toBe("error")
    if (events[0]?.type !== "error") throw new Error("expected error event")
    expect(events[0].message).toContain("copilot JSON parse failed")
  })

  it("captures session id from the final result event when session.start is absent", async () => {
    let sessionId = ""
    const events = []
    for await (const ev of parseCopilotJson(
      lineSource([
        JSON.stringify({ type: "assistant.message", data: { messageId: "m-1", content: "done" } }),
        JSON.stringify({
          type: "result",
          sessionId: "sid-from-result",
          exitCode: 0,
        }),
      ]),
      {
        onSessionId: (sid) => {
          sessionId = sid
        },
      },
    )) {
      events.push(ev)
    }

    expect(sessionId).toBe("sid-from-result")
    expect(events).toEqual([{ type: "assistant.delta", text: "done" }, { type: "done" }])
  })

  it("does not duplicate final assistant messages after streamed deltas", async () => {
    const events = await collect([
      JSON.stringify({ type: "assistant.message_delta", data: { deltaContent: "ok" } }),
      JSON.stringify({ type: "assistant.message", data: { messageId: "m-1", content: "ok" } }),
      JSON.stringify({ type: "result", sessionId: "sid-1", exitCode: 0 }),
    ])

    expect(events).toEqual([{ type: "assistant.delta", text: "ok" }, { type: "done" }])
  })
})

describe("copilot history helpers", () => {
  it("parses workspace yaml metadata", () => {
    expect(parseWorkspaceYaml('id: abc\ncwd: /repo\nname: "hello world"\nupdated_at: 2026-05-21T00:00:00Z\n')).toEqual({
      id: "abc",
      cwd: "/repo",
      name: "hello world",
      updatedAt: "2026-05-21T00:00:00Z",
      createdAt: undefined,
    })
  })

  it("hydrates user and assistant messages from events.jsonl", () => {
    const parsed = parseEvents(
      [
        JSON.stringify({ type: "session.start", data: { sessionId: "sid-1" }, timestamp: "2026-05-21T00:00:00Z" }),
        JSON.stringify({ type: "user.message", data: { content: "hello" }, timestamp: "2026-05-21T00:00:01Z" }),
        JSON.stringify({
          type: "assistant.message",
          data: { content: "hi back", toolRequests: [{ id: "call-1", name: "view", arguments: { path: "x" } }] },
          timestamp: "2026-05-21T00:00:02Z",
        }),
        JSON.stringify({
          type: "session.shutdown",
          data: {
            modelMetrics: { "gpt-5-mini": { usage: { inputTokens: 1, outputTokens: 2 } } },
            currentTokens: 3,
          },
        }),
      ].join("\n"),
      "fallback",
    )
    expect(parsed.firstUserMessage).toBe("hello")
    expect(parsed.usageMetrics).toEqual({ input_tokens: 1, output_tokens: 2, context_tokens: 3 })
    expect(parsed.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(parsed.messages[1]?.blocks).toEqual([
      { type: "text", text: "hi back" },
      { type: "tool_call", callId: "call-1", name: "view", input: { path: "x" } },
    ])
  })

  it("derives usage from Copilot model metrics", () => {
    expect(
      copilotUsageToSnapshot({
        modelMetrics: {
          "gpt-5-mini": { usage: { inputTokens: 2, outputTokens: 4, cacheReadTokens: 1 } },
          "claude-haiku-4.5": { usage: { inputTokens: 3, outputTokens: 5 } },
        },
        currentTokens: 9,
      }),
    ).toEqual({ input_tokens: 5, output_tokens: 9, cache_read_input_tokens: 1, context_tokens: 9 })
  })
})
