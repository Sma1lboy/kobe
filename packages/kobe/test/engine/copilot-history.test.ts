import { mkdir, mkdtemp, readFile, readdir, unlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CopilotHistoryDeps } from "@/engine/copilot-local/history"
import { readHistoryWithMetrics } from "@/engine/copilot-local/history"
import { listSessionsForCwd } from "@/engine/copilot-local/sessions"
import { describe, expect, it } from "vitest"

describe("copilot history", () => {
  it("loads session-state event JSONL into neutral messages", async () => {
    const root = await makeCopilotRoot()
    const sessionDir = path.join(root, "session-state", "session-1")
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      path.join(sessionDir, "events.jsonl"),
      [
        JSON.stringify({ type: "user.message", timestamp: "2026-05-16T10:00:00Z", data: { content: "hello" } }),
        JSON.stringify({
          type: "assistant.message",
          timestamp: "2026-05-16T10:00:01Z",
          data: { content: "hi", outputTokens: 2, toolRequests: [] },
        }),
        JSON.stringify({ type: "session.shutdown", data: { currentTokens: 123 } }),
      ].join("\n"),
    )

    const history = await readHistoryWithMetrics("session-1", depsFor(root))

    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(history.messages[1]?.blocks).toEqual([{ type: "text", text: "hi" }])
    expect(history.usageMetrics).toEqual({ input_tokens: 0, output_tokens: 2, context_tokens: 123 })
  })

  it("rejects session ids that escape session-state", async () => {
    const root = await makeCopilotRoot()

    await expect(readHistoryWithMetrics("../outside", depsFor(root))).rejects.toThrow("Invalid Copilot session id")
  })

  it("deduplicates repeated tool execution starts", async () => {
    const root = await makeCopilotRoot()
    const sessionDir = path.join(root, "session-state", "session-1")
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      path.join(sessionDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "tool.execution_start",
          timestamp: "2026-05-16T10:00:00Z",
          data: { toolCallId: "call-1", toolName: "shell", arguments: [{ command: "git status" }] },
        }),
        JSON.stringify({
          type: "tool.execution_start",
          timestamp: "2026-05-16T10:00:01Z",
          data: { toolCallId: "call-1", toolName: "shell", arguments: [{ command: "git status" }] },
        }),
        JSON.stringify({
          type: "tool.execution_complete",
          timestamp: "2026-05-16T10:00:02Z",
          data: { toolCallId: "call-1", success: true, result: { content: "clean" } },
        }),
      ].join("\n"),
    )

    const history = await readHistoryWithMetrics("session-1", depsFor(root))
    const toolCalls = history.messages.flatMap((message) =>
      message.blocks.filter((block) => block.type === "tool_call"),
    )

    expect(toolCalls).toHaveLength(1)
  })

  it("hydrates reasoningText from assistant messages without duplicating reasoning records", async () => {
    const root = await makeCopilotRoot()
    const sessionDir = path.join(root, "session-state", "session-1")
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      path.join(sessionDir, "events.jsonl"),
      [
        JSON.stringify({
          type: "assistant.reasoning",
          timestamp: "2026-05-16T10:00:00Z",
          data: { reasoningId: "r1", content: "checked history" },
        }),
        JSON.stringify({
          type: "assistant.message",
          timestamp: "2026-05-16T10:00:01Z",
          data: { content: "done", reasoningText: "checked history" },
        }),
      ].join("\n"),
    )

    const history = await readHistoryWithMetrics("session-1", depsFor(root))
    const thinkingBlocks = history.messages.flatMap((message) =>
      message.blocks.filter((block) => block.type === "thinking"),
    )

    expect(thinkingBlocks).toEqual([{ type: "thinking", text: "checked history" }])
    expect(history.messages.at(-1)?.blocks).toEqual([{ type: "text", text: "done" }])
  })

  it("hydrates reasoningText from assistant messages when no reasoning record exists", async () => {
    const root = await makeCopilotRoot()
    const sessionDir = path.join(root, "session-state", "session-1")
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      path.join(sessionDir, "events.jsonl"),
      JSON.stringify({
        type: "assistant.message",
        timestamp: "2026-05-16T10:00:00Z",
        data: { content: "done", reasoningText: "checked history" },
      }),
    )

    const history = await readHistoryWithMetrics("session-1", depsFor(root))

    expect(history.messages).toHaveLength(1)
    expect(history.messages[0]?.blocks).toEqual([
      { type: "thinking", text: "checked history" },
      { type: "text", text: "done" },
    ])
  })

  it("lists sessions for a cwd via workspace.yaml", async () => {
    const root = await makeCopilotRoot()
    const cwd = "/tmp/kobe-copilot-repo"
    const sessionDir = path.join(root, "session-state", "session-1")
    await mkdir(sessionDir, { recursive: true })
    await writeFile(
      path.join(sessionDir, "workspace.yaml"),
      ["id: session-1", `cwd: ${cwd}`, "created_at: 2026-05-16T10:00:00Z", "updated_at: 2026-05-16T10:00:01Z"].join(
        "\n",
      ),
    )
    const eventsPath = path.join(sessionDir, "events.jsonl")
    await writeFile(
      eventsPath,
      JSON.stringify({ type: "user.message", timestamp: "2026-05-16T10:00:00Z", data: { content: "first prompt" } }),
    )
    await utimes(eventsPath, new Date("2026-05-16T10:00:01Z"), new Date("2026-05-16T10:00:01Z"))

    const sessions = await listSessionsForCwd(cwd, depsFor(root))

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ sessionId: "session-1", firstUserMessage: "first prompt", messageCount: 1 })
  })
})

async function makeCopilotRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "kobe-copilot-"))
}

function depsFor(root: string): CopilotHistoryDeps {
  return {
    copilotDir: () => root,
    async readdir(p: string) {
      try {
        return await readdir(p)
      } catch {
        return []
      }
    },
    async readFile(p: string) {
      return await readFile(p, "utf8")
    },
    unlink,
  }
}
