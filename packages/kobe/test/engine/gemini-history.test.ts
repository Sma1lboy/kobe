import { mkdir, mkdtemp, readFile, readdir, unlink, utimes, writeFile } from "node:fs/promises"
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

  it("loads pretty-printed legacy json conversations", async () => {
    const root = await makeGeminiRoot()
    const chats = path.join(root, "history", "repo", "chats")
    await mkdir(chats, { recursive: true })
    await writeFile(
      path.join(chats, "session-2026-05-15T10-00-legacy-s.json"),
      JSON.stringify(
        {
          sessionId: "legacy-session",
          startTime: "2026-05-15T10:00:00Z",
          lastUpdated: "2026-05-15T10:00:02Z",
          messages: [
            { id: "u1", timestamp: "2026-05-15T10:00:01Z", type: "user", content: "hello" },
            { id: "a1", timestamp: "2026-05-15T10:00:02Z", type: "gemini", content: "hi" },
          ],
        },
        null,
        2,
      ),
    )

    const history = await readHistoryWithMetrics("legacy-session", depsFor(root))

    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(history.messages[1]?.blocks).toEqual([{ type: "text", text: "hi" }])
  })

  it("accepts jsonl metadata records without projectHash", async () => {
    const root = await makeGeminiRoot()
    const chats = path.join(root, "tmp", "repo", "chats")
    await mkdir(chats, { recursive: true })
    await writeFile(
      path.join(chats, "session-2026-05-15T10-00-nohash-s.jsonl"),
      [
        JSON.stringify({
          sessionId: "nohash-session",
          startTime: "2026-05-15T10:00:00Z",
          lastUpdated: "2026-05-15T10:00:02Z",
        }),
        JSON.stringify({ id: "u1", timestamp: "2026-05-15T10:00:01Z", type: "user", content: "hello" }),
      ].join("\n"),
    )

    const history = await readHistoryWithMetrics("nohash-session", depsFor(root))

    expect(history.messages).toHaveLength(1)
    expect(history.messages[0]?.blocks).toEqual([{ type: "text", text: "hello" }])
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

  it("deduplicates sessions across Gemini tmp and history roots", async () => {
    const root = await makeGeminiRoot()
    const cwd = "/tmp/kobe-gemini-repo"
    await writeFile(path.join(root, "projects.json"), JSON.stringify({ projects: { [cwd]: "repo-slug" } }))
    const tmpChats = path.join(root, "tmp", "repo-slug", "chats")
    const historyChats = path.join(root, "history", "repo-slug", "chats")
    await mkdir(tmpChats, { recursive: true })
    await mkdir(historyChats, { recursive: true })
    const older = path.join(tmpChats, "session-2026-05-15T10-00-shared-s.jsonl")
    const newer = path.join(historyChats, "session-2026-05-15T10-01-shared-s.jsonl")
    await writeFile(
      older,
      [
        JSON.stringify({ sessionId: "shared-session", lastUpdated: "2026-05-15T10:00:00Z" }),
        JSON.stringify({ id: "u1", type: "user", content: "old prompt" }),
      ].join("\n"),
    )
    await writeFile(
      newer,
      [
        JSON.stringify({ sessionId: "shared-session", lastUpdated: "2026-05-15T10:01:00Z" }),
        JSON.stringify({ id: "u1", type: "user", content: "new prompt" }),
      ].join("\n"),
    )
    await utimes(older, new Date("2026-05-15T10:00:00Z"), new Date("2026-05-15T10:00:00Z"))
    await utimes(newer, new Date("2026-05-15T10:01:00Z"), new Date("2026-05-15T10:01:00Z"))

    const sessions = await listSessionsForCwd(cwd, depsFor(root))

    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ sessionId: "shared-session", firstUserMessage: "new prompt" })
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
