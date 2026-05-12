import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { HistoryDeps } from "@/engine/codex-local/history"
import { listSessionsForCwd } from "@/engine/codex-local/sessions"
import { describe, expect, it } from "vitest"

const CWD = "/tmp/kobe-codex-repo"

describe("codex session listing", () => {
  it("skips synthetic instruction rows when deriving firstUserMessage", async () => {
    const sessionsRoot = await makeSessionsRoot()
    const rolloutDir = path.join(sessionsRoot, "2026", "05", "12")
    await mkdir(rolloutDir, { recursive: true })

    const instructions = [
      "# AGENTS.md instructions for /tmp/repo",
      "",
      "<INSTRUCTIONS>",
      "# Project rules",
      "",
      "Read docs before coding.",
      "</INSTRUCTIONS>",
    ].join("\n")
    await writeFile(
      path.join(rolloutDir, "rollout-2026-05-12T10-00-00-000Z-session-1.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "session-1", cwd: CWD } }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-05-12T10:00:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: instructions }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-05-12T10:00:01Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "real first prompt" }] },
        }),
      ].join("\n"),
      "utf8",
    )

    const out = await listSessionsForCwd(CWD, depsFor(sessionsRoot))

    expect(out).toHaveLength(1)
    expect(out[0]?.firstUserMessage).toBe("real first prompt")
  })

  it("counts every message line, not just the head window", async () => {
    const sessionsRoot = await makeSessionsRoot()
    const rolloutDir = path.join(sessionsRoot, "2026", "05", "12")
    await mkdir(rolloutDir, { recursive: true })

    const TOTAL_MESSAGES = 120
    const lines = [JSON.stringify({ type: "session_meta", payload: { id: "session-long", cwd: CWD } })]
    for (let i = 0; i < TOTAL_MESSAGES; i++) {
      lines.push(
        JSON.stringify({
          type: "response_item",
          timestamp: `2026-05-12T10:${String(i % 60).padStart(2, "0")}:00Z`,
          payload: {
            type: "message",
            role: i % 2 === 0 ? "user" : "assistant",
            content: [{ type: "input_text", text: `message ${i}` }],
          },
        }),
      )
    }
    await writeFile(path.join(rolloutDir, "rollout-2026-05-12T10-00-00-000Z-session-long.jsonl"), lines.join("\n"), "utf8")

    const out = await listSessionsForCwd(CWD, depsFor(sessionsRoot))

    expect(out).toHaveLength(1)
    expect(out[0]?.messageCount).toBe(TOTAL_MESSAGES)
  })

  it("skips synthetic environment rows when deriving firstUserMessage", async () => {
    const sessionsRoot = await makeSessionsRoot()
    const rolloutDir = path.join(sessionsRoot, "2026", "05", "12")
    await mkdir(rolloutDir, { recursive: true })

    const envelope = "<environment_context>\n  <cwd>/tmp/work</cwd>\n  <shell>zsh</shell>\n</environment_context>"
    await writeFile(
      path.join(rolloutDir, "rollout-2026-05-12T10-00-00-000Z-session-2.jsonl"),
      [
        JSON.stringify({ type: "session_meta", payload: { id: "session-2", cwd: CWD } }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-05-12T10:00:00Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: envelope }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-05-12T10:00:01Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "actual question" }] },
        }),
      ].join("\n"),
      "utf8",
    )

    const out = await listSessionsForCwd(CWD, depsFor(sessionsRoot))

    expect(out).toHaveLength(1)
    expect(out[0]?.firstUserMessage).toBe("actual question")
  })
})

async function makeSessionsRoot(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "kobe-codex-sessions-"))
}

function depsFor(root: string): HistoryDeps {
  return {
    sessionsDir: () => root,
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
  }
}
