/**
 * Auto-title behavior parity through the engine registry (KOB-233).
 *
 * auto-title.ts used to pick its history reader with an inline vendor
 * if-ladder; it now resolves `engineEntry(vendor).history`. These tests
 * pin the behavior that must not have changed:
 *
 *  - claude: read the worktree's `~/.claude/projects/*` transcripts
 *    OLDEST-first and return the first user prompt, truncated;
 *  - custom vendor: NO transcript store — return "" (keep the
 *    placeholder) instead of falling through to claude's files.
 *
 * Claude's lister stats the real filesystem rooted at `homedir()`, so we
 * point $HOME at a temp dir (same pattern the engine mtime tests use for
 * temp-dir-backed claude fixtures).
 */

import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { encodeCwd } from "../../src/engine/claude-code-local/history.ts"
import {
  deriveTitleFromSession,
  deriveTitleFromSessionId,
  deriveTitleInputFromSession,
} from "../../src/monitor/auto-title.ts"

const WORKTREE = "/work/tree"

let home: string
let savedHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kobe-auto-title-"))
  savedHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = savedHome
})

/** Write a claude session JSONL under the temp $HOME's project dir. */
async function writeSession(sessionId: string, lines: string[], mtimeSec: number): Promise<string> {
  const dir = path.join(home, ".claude", "projects", encodeCwd(WORKTREE))
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  await writeFile(file, `${lines.join("\n")}\n`)
  await utimes(file, mtimeSec, mtimeSec)
  return file
}

function userLine(sessionId: string, text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    timestamp: "2026-06-09T00:00:00.000Z",
    sessionId,
  })
}

function assistantLine(sessionId: string, text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: text },
    timestamp: "2026-06-09T00:00:01.000Z",
    sessionId,
  })
}

describe("deriveTitleFromSession (claude, through the registry)", () => {
  it("returns the first user prompt of the worktree's session", async () => {
    await writeSession("aaaa-1111", [userLine("aaaa-1111", "Fix the flaky login test")], 1_000)
    await expect(deriveTitleFromSession(WORKTREE, "claude")).resolves.toBe("Fix the flaky login test")
  })

  it("walks sessions OLDEST-first so the origin conversation wins", async () => {
    await writeSession("newer-2222", [userLine("newer-2222", "a follow-up prompt")], 2_000)
    await writeSession("older-1111", [userLine("older-1111", "the origin prompt")], 1_000)
    await expect(deriveTitleFromSession(WORKTREE, "claude")).resolves.toBe("the origin prompt")
  })

  it("skips a session whose first user record has no text, on to the next", async () => {
    // Oldest session opens with a non-text user record (tool result shape).
    await writeSession(
      "older-1111",
      [
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] },
          sessionId: "older-1111",
        }),
      ],
      1_000,
    )
    await writeSession("newer-2222", [userLine("newer-2222", "usable prompt")], 2_000)
    await expect(deriveTitleFromSession(WORKTREE, "claude")).resolves.toBe("usable prompt")
  })

  it("returns '' when the worktree has no transcripts", async () => {
    await expect(deriveTitleFromSession(WORKTREE, "claude")).resolves.toBe("")
  })

  it("returns bounded title input plus a first-sentence fallback", async () => {
    await writeSession(
      "aaaa-1111",
      [
        userLine(
          "aaaa-1111",
          "Fix login button. The reproduction details are long and should not all become the fallback.",
        ),
        assistantLine("aaaa-1111", "I will inspect the auth form and update the mobile handler."),
      ],
      1_000,
    )

    const input = await deriveTitleInputFromSession(WORKTREE, "claude")

    expect(input?.fallbackTitle).toBe("Fix login button.")
    expect(input?.text).toContain("Fix login button")
    expect(input?.text).toContain("inspect the auth form")
    expect(input?.text.length).toBeLessThanOrEqual(1000)
  })

  it("tail-caps title input to the latest 1000 characters", async () => {
    const older = `older-${"a".repeat(1100)}`
    const recent = `recent-${"b".repeat(80)}`
    await writeSession("aaaa-1111", [userLine("aaaa-1111", older), assistantLine("aaaa-1111", recent)], 1_000)

    const input = await deriveTitleInputFromSession(WORKTREE, "claude")

    expect(input?.text.length).toBe(1000)
    expect(input?.text).not.toContain("older-")
    expect(input?.text).toContain("recent-")
  })
})

describe("deriveTitleFromSession (custom vendor)", () => {
  it("returns '' instead of mis-reading claude's transcripts", async () => {
    // A claude transcript EXISTS for the worktree — the old `else → claude`
    // default would have read it; the registry's empty entry must not.
    await writeSession("aaaa-1111", [userLine("aaaa-1111", "claude-only prompt")], 1_000)
    await expect(deriveTitleFromSession(WORKTREE, "my-custom-engine")).resolves.toBe("")
  })
})

describe("deriveTitleFromSessionId", () => {
  it("reads one claude session by id", async () => {
    await writeSession("bbbb-2222", [userLine("bbbb-2222", "rename the API endpoints")], 1_000)
    await expect(deriveTitleFromSessionId("claude", "bbbb-2222")).resolves.toBe("rename the API endpoints")
  })

  it("returns '' for a custom vendor and for a blank id", async () => {
    await writeSession("bbbb-2222", [userLine("bbbb-2222", "claude-only prompt")], 1_000)
    await expect(deriveTitleFromSessionId("my-custom-engine", "bbbb-2222")).resolves.toBe("")
    await expect(deriveTitleFromSessionId("claude", "")).resolves.toBe("")
  })
})
