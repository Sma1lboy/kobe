/**
 * Unit tests for `readHistory` + `parseJsonl`.
 *
 * We write a real JSONL file under a tmpdir, point the impl at it via
 * dependency injection, and assert the parsed `Message[]`. This keeps
 * the tests cheap (no mocks) while exercising the actual file IO.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { encodeCwd, parseJsonl, readHistory } from "@/engine/claude-code-local/history"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let root: string
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "kobe-history-"))
})
afterEach(() => {
  // Per project policy: NEVER call rm without the user saying so.
  // Tmp directories are reaped by the OS; leave them.
})

describe("encodeCwd", () => {
  it("replaces / with - to match Claude Code's on-disk encoding", () => {
    expect(encodeCwd("/Users/jackson/i/kobe")).toBe("-Users-jackson-i-kobe")
  })
  it("replaces dots with - too (matches claude's behavior on dirs like 1.2.3)", () => {
    expect(encodeCwd("/proj/1.2.3")).toBe("-proj-1-2-3")
  })
})

describe("parseJsonl", () => {
  it("parses message records into the canonical Message shape", () => {
    const raw = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello" },
        timestamp: "2026-05-09T03:59:51.343Z",
        sessionId: "s1",
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hi back" }],
        },
        timestamp: "2026-05-09T03:59:52.000Z",
        sessionId: "s1",
      }),
    ].join("\n")

    const msgs = parseJsonl(raw, "s1")
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({
      role: "user",
      content: "hello",
      timestamp: "2026-05-09T03:59:51.343Z",
      sessionId: "s1",
    })
    expect(msgs[1]?.role).toBe("assistant")
    expect(msgs[1]?.content).toEqual([{ type: "text", text: "hi back" }])
  })

  it("skips non-message records (permission-mode, file-history-snapshot, etc.)", () => {
    const raw = [
      JSON.stringify({
        type: "permission-mode",
        permissionMode: "auto",
        sessionId: "s1",
      }),
      JSON.stringify({
        type: "file-history-snapshot",
        messageId: "m1",
        snapshot: {},
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "real message" },
        timestamp: "2026-05-09T03:59:51.343Z",
        sessionId: "s1",
      }),
    ].join("\n")

    const msgs = parseJsonl(raw, "s1")
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.content).toBe("real message")
  })

  it("falls back to the supplied sessionId when the record omits one", () => {
    const raw = JSON.stringify({
      message: { role: "user", content: "no-sid" },
      timestamp: "2026-05-09T00:00:00.000Z",
    })
    const msgs = parseJsonl(raw, "fallback-sid")
    expect(msgs[0]?.sessionId).toBe("fallback-sid")
  })

  it("skips bad JSON lines without crashing", () => {
    const raw = [
      "{this is not json",
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "ok" },
        timestamp: "2026-05-09T00:00:00.000Z",
        sessionId: "s1",
      }),
    ].join("\n")
    const msgs = parseJsonl(raw, "s1")
    expect(msgs).toHaveLength(1)
  })
})

describe("readHistory", () => {
  it("reads the JSONL file from <projectsDir>/<encoded-cwd>/<sessionId>.jsonl", async () => {
    const cwd = "/some/fake/proj"
    const encoded = encodeCwd(cwd)
    const sessionId = "session-A"
    const projectDir = path.join(root, encoded)
    mkdirSync(projectDir, { recursive: true })

    const jsonl = JSON.stringify({
      type: "user",
      message: { role: "user", content: "what is up" },
      timestamp: "2026-05-09T00:00:00.000Z",
      sessionId,
      cwd,
    })
    writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), `${jsonl}\n`, "utf8")

    const messages = await readHistory(sessionId, {
      projectsDir: () => root,
      readdir: async (p) => {
        const fs = await import("node:fs/promises")
        return fs.readdir(p)
      },
      readFile: async (p) => {
        const fs = await import("node:fs/promises")
        return fs.readFile(p, "utf8")
      },
      pathExists: async () => true,
    })

    expect(messages).toHaveLength(1)
    expect(messages[0]?.role).toBe("user")
    expect(messages[0]?.content).toBe("what is up")
    expect(messages[0]?.sessionId).toBe(sessionId)
  })

  it("returns [] when the session id has no JSONL anywhere under the projects dir", async () => {
    mkdirSync(path.join(root, "-some-proj"), { recursive: true })
    const messages = await readHistory("missing-session", {
      projectsDir: () => root,
      readdir: async (p) => {
        const fs = await import("node:fs/promises")
        return fs.readdir(p)
      },
      readFile: async (p) => {
        const fs = await import("node:fs/promises")
        return fs.readFile(p, "utf8")
      },
      pathExists: async () => true,
    })
    expect(messages).toEqual([])
  })

  it("locates the file even when projects dir contains many unrelated dirs", async () => {
    // Multiple project dirs; the right session lives in the second.
    const sid = "needle"
    mkdirSync(path.join(root, "-a-b-c"), { recursive: true })
    mkdirSync(path.join(root, "-x-y-z"), { recursive: true })
    writeFileSync(
      path.join(root, "-x-y-z", `${sid}.jsonl`),
      `${JSON.stringify({
        message: { role: "assistant", content: "found me" },
        timestamp: "2026-05-09T00:00:00.000Z",
        sessionId: sid,
      })}\n`,
      "utf8",
    )

    const messages = await readHistory(sid, {
      projectsDir: () => root,
      readdir: async (p) => {
        const fs = await import("node:fs/promises")
        return fs.readdir(p)
      },
      readFile: async (p) => {
        const fs = await import("node:fs/promises")
        return fs.readFile(p, "utf8")
      },
      pathExists: async () => true,
    })
    expect(messages[0]?.content).toBe("found me")
  })
})
