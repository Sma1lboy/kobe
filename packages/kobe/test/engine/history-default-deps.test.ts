/**
 * Drives the REAL default FS deps of the engine history readers against a
 * temp `$HOME` (node:os `homedir` is mocked to a mkdtemp dir; all file I/O is
 * genuine). Round-1 edge-case suites cover the parsers through injected
 * deps; what was left uncovered is exactly the default-deps wiring — the
 * `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` directory-layout
 * knowledge, the tolerate-ENOENT loops, and deleteHistory's non-ENOENT
 * rethrow. A regression here means the TUI reads/deletes the wrong files on
 * a real machine while every injected-deps test stays green.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterAll, describe, expect, it, vi } from "vitest"

const tmpHome = mkdtempSync(path.join(tmpdir(), "kobe-hist-home-"))

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>()
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } }
})

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    unlink: async (p: string) => {
      if (p.includes("locked-session") || p.includes("eacc0000")) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException
        err.code = "EACCES"
        throw err
      }
      return actual.unlink(p)
    },
  }
})

import {
  appendInterruptedUserPrompt,
  deleteHistory,
  encodeCwd,
  latestTranscriptMtimeForWorktree,
  listSessionFilesForWorktree,
  readHistory,
} from "../../src/engine/claude-code-local/history.ts"
import {
  deleteHistory as codexDeleteHistory,
  findLatestRolloutForWorktree as codexFindLatestRollout,
  readHistoryWithMetrics as codexReadHistory,
} from "../../src/engine/codex-local/history.ts"
import {
  deleteHistory as copilotDeleteHistory,
  listSessionDirs as copilotListSessionDirs,
  latestTranscriptMtimeForWorktree as copilotMtimeForWorktree,
} from "../../src/engine/copilot-local/history.ts"

const projectsRoot = path.join(tmpHome, ".claude", "projects")

function writeSession(cwd: string, sessionId: string, lines: string[]): string {
  const dir = path.join(projectsRoot, encodeCwd(cwd))
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  writeFileSync(file, `${lines.join("\n")}\n`)
  return file
}

function userLine(text: string, sessionId: string, timestamp: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    timestamp,
    sessionId,
  })
}

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

describe("encodeCwd", () => {
  it("replaces both / and . with - (Claude Code's lossy on-disk encoding)", () => {
    expect(encodeCwd("/Users/j/i/kobe")).toBe("-Users-j-i-kobe")
    expect(encodeCwd("/v/1.2.3")).toBe("-v-1-2-3")
  })
})

describe("fresh HOME — no engine dirs on disk yet", () => {
  // Runs FIRST (before sibling suites create ~/.claude/projects): the
  // default readdir must swallow the missing-root ENOENT, not throw.
  it("readHistory degrades to [] when ~/.claude/projects does not exist", async () => {
    await expect(readHistory("preboot-session")).resolves.toEqual([])
  })

  it("codex readHistory degrades to empty when ~/.codex/sessions does not exist", async () => {
    await expect(codexReadHistory("aaaa1111-2222-3333-4444-555566667777")).resolves.toEqual({ messages: [] })
  })

  it("copilot listSessionDirs degrades to [] when ~/.copilot does not exist", async () => {
    const original = process.env.COPILOT_HOME
    Reflect.deleteProperty(process.env, "COPILOT_HOME")
    try {
      await expect(copilotListSessionDirs()).resolves.toEqual([])
    } finally {
      if (original !== undefined) process.env.COPILOT_HOME = original
    }
  })
})

describe("listSessionFilesForWorktree (real default deps)", () => {
  it("returns [] for an empty worktree arg and for a worktree never entered", async () => {
    await expect(listSessionFilesForWorktree("")).resolves.toEqual([])
    await expect(listSessionFilesForWorktree("/never/entered")).resolves.toEqual([])
  })

  it("lists only .jsonl files, newest mtime first, and tolerates a vanishing entry", async () => {
    const wt = "/repo/wt-list"
    const older = writeSession(wt, "aaaa", [userLine("old", "aaaa", "2026-01-01T00:00:00Z")])
    const newer = writeSession(wt, "bbbb", [userLine("new", "bbbb", "2026-01-02T00:00:00Z")])
    utimesSync(older, new Date("2026-01-01"), new Date("2026-01-01"))
    utimesSync(newer, new Date("2026-06-01"), new Date("2026-06-01"))
    const dir = path.join(projectsRoot, encodeCwd(wt))
    writeFileSync(path.join(dir, "notes.txt"), "not a session")
    // Dangling symlink: readdir lists it, stat fails → kept with mtime 0.
    symlinkSync(path.join(dir, "gone.target"), path.join(dir, "cccc.jsonl"))

    const files = await listSessionFilesForWorktree(wt)
    expect(files.map((f) => f.sessionId)).toEqual(["bbbb", "aaaa", "cccc"])
    expect(files[2]?.mtimeMs).toBe(0)
    await expect(latestTranscriptMtimeForWorktree(wt)).resolves.toBe(new Date("2026-06-01").getTime())
    await expect(latestTranscriptMtimeForWorktree("/never/entered")).resolves.toBe(0)
  })
})

describe("readHistory (real default deps)", () => {
  it("scans every project dir for <sessionId>.jsonl and returns timestamp-sorted messages", async () => {
    // A sibling project dir WITHOUT the session file must be skipped, not fatal.
    mkdirSync(path.join(projectsRoot, encodeCwd("/repo/other")), { recursive: true })
    writeSession("/repo/wt-read", "dddd", [
      userLine("second", "dddd", "2026-01-02T00:00:00Z"),
      "{not json — must be skipped, not fatal",
      userLine("first", "dddd", "2026-01-01T00:00:00Z"),
      // Same timestamp as "second": the sort is stable, file-order wins the tie.
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "tied", usage: { input_tokens: 10, output_tokens: 3 } },
        timestamp: "2026-01-02T00:00:00Z",
        sessionId: "dddd",
      }),
    ])
    const messages = await readHistory("dddd")
    expect(messages.map((m) => m.blocks)).toEqual([
      [{ type: "text", text: "first" }],
      [{ type: "text", text: "second" }],
      [{ type: "text", text: "tied" }],
    ])
    // usage survives normalization when both token counts are present.
    expect(messages[2]?.usage).toEqual({ input_tokens: 10, output_tokens: 3 })
  })

  it("returns [] when no project dir holds the session (and when ~/.claude is empty)", async () => {
    await expect(readHistory("no-such-session")).resolves.toEqual([])
  })
})

describe("deleteHistory (real default deps)", () => {
  it("removes the matching .jsonl, tolerating every dir where it is absent", async () => {
    const file = writeSession("/repo/wt-del", "eeee", [userLine("bye", "eeee", "2026-01-01T00:00:00Z")])
    await deleteHistory("eeee")
    expect(readdirSync(path.dirname(file))).not.toContain("eeee.jsonl")
    // Fully-absent session: pure ENOENT loop, resolves silently.
    await expect(deleteHistory("eeee")).resolves.toBeUndefined()
  })

  it("rethrows a non-ENOENT unlink failure (permissions must surface to the orchestrator)", async () => {
    writeSession("/repo/wt-locked", "locked-session", [userLine("x", "locked-session", "2026-01-01T00:00:00Z")])
    await expect(deleteHistory("locked-session")).rejects.toMatchObject({ code: "EACCES" })
  })
})

describe("appendInterruptedUserPrompt (real default deps)", () => {
  it("coalesces onto a TOP-LEVEL-role user record (no message wrapper), skipping malformed tail lines", async () => {
    const cwd = "/repo/wt-append"
    const file = writeSession(cwd, "ffff", [
      // Legacy shape: role+content at the record top level, not under .message.
      JSON.stringify({
        role: "user",
        content: "earlier rescued prompt",
        uuid: "u-1",
        parentUuid: "p-0",
        timestamp: "2026-01-01T00:00:00Z",
        sessionId: "ffff",
      }),
      "{corrupt trailing line",
    ])

    await appendInterruptedUserPrompt("ffff", cwd, "newest prompt")

    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    expect(lines).toHaveLength(3)
    const appended = JSON.parse(lines[2] as string) as {
      message: { content: string }
      parentUuid: string | null
    }
    // Coalesced text carries the earlier turn forward, chained to its PARENT
    // (superseding the un-replied sibling, never two back-to-back user rows).
    expect(appended.message.content).toBe("earlier rescued prompt\n\nnewest prompt")
    expect(appended.parentUuid).toBe("p-0")
  })

  it("is a no-op for a blank prompt", async () => {
    await expect(appendInterruptedUserPrompt("gggg", "/repo/wt-append", "   ")).resolves.toBeUndefined()
    expect(existsSync(path.join(projectsRoot, encodeCwd("/repo/wt-append"), "gggg.jsonl"))).toBe(false)
  })
})

describe("codex history (real default deps)", () => {
  const rollout = path.join(
    tmpHome,
    ".codex",
    "sessions",
    "2026",
    "01",
    "05",
    "rollout-2026-01-05T10-00-00-cccc1111-2222-3333-4444-555566667777.jsonl",
  )

  it("finds a rollout by session UUID in the date tree, sorts by timestamp, and deletes it", async () => {
    mkdirSync(path.dirname(rollout), { recursive: true })
    writeFileSync(
      rollout,
      `${[
        JSON.stringify({ type: "session_meta", payload: { id: "cccc1111-2222-3333-4444-555566667777", cwd: "/w" } }),
        // Out of file order on purpose: readHistory must sort by timestamp.
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-01-05T10:00:05Z",
          payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "later" }] },
        }),
        JSON.stringify({
          type: "response_item",
          timestamp: "2026-01-05T10:00:01Z",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi codex" }] },
        }),
      ].join("\n")}\n`,
    )
    const history = await codexReadHistory("cccc1111-2222-3333-4444-555566667777")
    expect(history.messages.map((m) => m.blocks)).toEqual([
      [{ type: "text", text: "hi codex" }],
      [{ type: "text", text: "later" }],
    ])

    await codexDeleteHistory("cccc1111-2222-3333-4444-555566667777")
    expect(readdirSync(path.dirname(rollout))).toEqual([])
    // Absent session: no-op, never throws.
    await expect(codexDeleteHistory("cccc1111-2222-3333-4444-555566667777")).resolves.toBeUndefined()
  })

  it("rethrows a non-ENOENT unlink failure from deleteHistory", async () => {
    const locked = path.join(
      path.dirname(rollout),
      "rollout-2026-01-05T11-00-00-eacc0000-1111-2222-3333-444455556666.jsonl",
    )
    writeFileSync(locked, `${JSON.stringify({ type: "session_meta", payload: { id: "x", cwd: "/w" } })}\n`)
    await expect(codexDeleteHistory("eacc0000-1111-2222-3333-444455556666")).rejects.toMatchObject({
      code: "EACCES",
    })
  })

  it("tolerates an unreadable rollout during the worktree scan (skips, keeps scanning)", async () => {
    // A DIRECTORY named like a rollout: listed by the tree walk, readFile
    // explodes with EISDIR — the cwd probe must degrade to "no match".
    const bogus = path.join(
      path.dirname(rollout),
      "rollout-2026-01-05T12-00-00-dddd0000-1111-2222-3333-444455556666.jsonl",
    )
    mkdirSync(bogus)
    const good = path.join(
      path.dirname(rollout),
      "rollout-2026-01-05T09-00-00-bbbb0000-1111-2222-3333-444455556666.jsonl",
    )
    writeFileSync(good, `${JSON.stringify({ type: "session_meta", payload: { id: "b", cwd: "/scan-wt" } })}\n`)
    const found = await codexFindLatestRollout("/scan-wt")
    expect(found?.path).toBe(good)
  })
})

describe("copilot history (real default deps)", () => {
  it("resolves ~/.copilot by default and honours the COPILOT_HOME override", async () => {
    const original = process.env.COPILOT_HOME
    try {
      Reflect.deleteProperty(process.env, "COPILOT_HOME")
      mkdirSync(path.join(tmpHome, ".copilot", "session-state", "s1"), { recursive: true })
      await expect(copilotListSessionDirs()).resolves.toEqual([path.join(tmpHome, ".copilot", "session-state", "s1")])

      const override = mkdtempSync(path.join(tmpdir(), "kobe-copilot-home-"))
      try {
        process.env.COPILOT_HOME = override
        mkdirSync(path.join(override, "session-state", "s2"), { recursive: true })
        await expect(copilotListSessionDirs()).resolves.toEqual([path.join(override, "session-state", "s2")])
        // stat default dep: no events.jsonl anywhere → mtime 0.
        await expect(copilotMtimeForWorktree("/nowhere")).resolves.toBe(0)

        // rm default dep: deleteHistory removes the whole session dir.
        await copilotDeleteHistory("s2")
        expect(existsSync(path.join(override, "session-state", "s2"))).toBe(false)
      } finally {
        rmSync(override, { recursive: true, force: true })
      }
    } finally {
      if (original === undefined) Reflect.deleteProperty(process.env, "COPILOT_HOME")
      else process.env.COPILOT_HOME = original
    }
  })
})
