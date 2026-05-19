/**
 * Unit tests for `buildClaudeShellCommand` + `sniffNewSessionId`. Pure
 * helpers, so no fs IO or subprocess spawning — the sniffer's `list`
 * dep is stubbed inline per test.
 */

import { describe, expect, it } from "vitest"
import { buildClaudeShellCommand, sniffNewSessionId } from "../../src/tmux/claude-spawn.ts"

describe("buildClaudeShellCommand", () => {
  it("with no resume → cd '<cwd>' && exec '<bin>'", () => {
    const cmd = buildClaudeShellCommand({ binaryPath: "/usr/bin/claude", cwd: "/Users/x/repo" })
    expect(cmd).toBe(`cd '/Users/x/repo' && exec '/usr/bin/claude'`)
  })

  it("with resume → appends --resume '<sid>'", () => {
    const cmd = buildClaudeShellCommand({
      binaryPath: "/usr/bin/claude",
      cwd: "/Users/x/repo",
      resumeSessionId: "abc-123",
    })
    expect(cmd).toBe(`cd '/Users/x/repo' && exec '/usr/bin/claude' --resume 'abc-123'`)
  })

  it("escapes single quotes in cwd via the '\\'' trick", () => {
    const cmd = buildClaudeShellCommand({
      binaryPath: "/usr/bin/claude",
      cwd: "/tmp/a'b",
    })
    expect(cmd).toBe(`cd '/tmp/a'\\''b' && exec '/usr/bin/claude'`)
  })

  it("escapes single quotes in binaryPath and resumeSessionId too", () => {
    const cmd = buildClaudeShellCommand({
      binaryPath: "/tmp/b'in/claude",
      cwd: "/cwd",
      resumeSessionId: "s'id",
    })
    expect(cmd).toBe(`cd '/cwd' && exec '/tmp/b'\\''in/claude' --resume 's'\\''id'`)
  })
})

describe("sniffNewSessionId", () => {
  const baseDeps = {
    encodeCwd: (s: string) => s.replace(/[/.]/g, "-"),
    homedir: () => "/home/u",
  }

  it("returns null when nothing new appeared", async () => {
    const before = new Set(["aaa.jsonl"])
    const got = await sniffNewSessionId("/x/repo", before, {
      ...baseDeps,
      list: async () => ["aaa.jsonl"],
    })
    expect(got).toBeNull()
  })

  it("returns the new id (sans .jsonl) when exactly one file appeared", async () => {
    const before = new Set(["aaa.jsonl"])
    const got = await sniffNewSessionId("/x/repo", before, {
      ...baseDeps,
      list: async () => ["aaa.jsonl", "bbb.jsonl"],
    })
    expect(got).toBe("bbb")
  })

  it("ignores non-.jsonl files", async () => {
    const before = new Set<string>()
    const got = await sniffNewSessionId("/x/repo", before, {
      ...baseDeps,
      list: async () => ["scratch.txt", "ignore.md", "real.jsonl"],
    })
    expect(got).toBe("real")
  })

  it("lists the encoded-cwd project directory under ~/.claude/projects", async () => {
    let seen = ""
    await sniffNewSessionId("/Users/x/repo.dir", new Set(), {
      ...baseDeps,
      list: async (p) => {
        seen = p
        return []
      },
    })
    // / and . both map to - via encodeCwd.
    expect(seen).toBe("/home/u/.claude/projects/-Users-x-repo-dir")
  })

  it("returns null on an empty listing (project dir not yet created)", async () => {
    const got = await sniffNewSessionId("/x/repo", new Set(), {
      ...baseDeps,
      list: async () => [],
    })
    expect(got).toBeNull()
  })
})
