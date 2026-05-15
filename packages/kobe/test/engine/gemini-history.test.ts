import { mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { GeminiHistoryDeps } from "@/engine/gemini-local/history"
import { readHistoryWithMetrics } from "@/engine/gemini-local/history"
import { listSessionsForCwd } from "@/engine/gemini-local/sessions"
import { describe, expect, it } from "vitest"

describe("gemini history", () => {
  it("loads jsonl chat records into neutral messages", async () => {
    const root = await makeGeminiRoot()
    const chats = path.join(root, "tmp", "repo", "chats")
    await mkdir(chats, { recursive: true })
    await writeFile(
      path.join(chats, "session-2026-05-15T10-00-abcd1234.jsonl"),
      [
        JSON.stringify({
          sessionId: "abcd1234-session",
          projectHash: "hash",
          startTime: "2026-05-15T10:00:00Z",
          lastUpdated: "2026-05-15T10:00:02Z",
        }),
        JSON.stringify({ id: "u1", timestamp: "2026-05-15T10:00:01Z", type: "user", content: [{ text: "hello" }] }),
        JSON.stringify({
          id: "a1",
          timestamp: "2026-05-15T10:00:02Z",
          type: "gemini",
          content: "hi",
          tokens: { input: 10, output: 2, cached: 3 },
        }),
      ].join("\n"),
    )

    const history = await readHistoryWithMetrics("abcd1234-session", depsFor(root))

    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(history.messages[1]?.blocks).toEqual([{ type: "text", text: "hi" }])
    expect(history.usageMetrics).toEqual({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3 })
  })

  it("lists sessions for a cwd via the Gemini project registry", async () => {
    const root = await makeGeminiRoot()
    const cwd = "/tmp/kobe-gemini-repo"
    await writeFile(path.join(root, "projects.json"), JSON.stringify({ projects: { [cwd]: "repo-slug" } }))
    const chats = path.join(root, "tmp", "repo-slug", "chats")
    await mkdir(chats, { recursive: true })
    await writeFile(
      path.join(chats, "session-2026-05-15T10-00-session1.jsonl"),
      [
        JSON.stringify({
          sessionId: "session1-full",
          projectHash: "hash",
          startTime: "2026-05-15T10:00:00Z",
          lastUpdated: "2026-05-15T10:00:02Z",
        }),
        JSON.stringify({
          id: "u1",
          timestamp: "2026-05-15T10:00:01Z",
          type: "user",
          content: [{ text: "first prompt" }],
        }),
      ].join("\n"),
    )

    const sessions = await listSessionsForCwd(cwd, depsFor(root))

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ sessionId: "session1-full", firstUserMessage: "first prompt", messageCount: 1 })
  })
})

async function makeGeminiRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "kobe-gemini-"))
}

function depsFor(root: string): GeminiHistoryDeps {
  return {
    geminiDir: () => root,
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
