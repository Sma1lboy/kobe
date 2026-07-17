/**
 * Activity-poll transcript-mtime readers (KOB-254). Each engine exposes
 * `latestTranscriptMtimeForWorktree(worktree)` returning the newest
 * transcript mtime for a worktree (0 when none) — the signal the Ops
 * pane polls to light its "new activity" badge. Codex/Copilot are
 * tested with injected deps; Claude uses a real temp dir since its
 * lister stats the filesystem directly.
 */

import { mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { latestTranscriptMtimeForWorktree as claudeMtime } from "../../src/engine/claude-code-local/history.ts"
import {
  type HistoryDeps as CodexDeps,
  findLatestRolloutForWorktree as codexFindLatest,
  latestTranscriptMtimeForWorktree as codexMtime,
} from "../../src/engine/codex-local/history.ts"
import {
  type CopilotHistoryDeps,
  latestTranscriptMtimeForWorktree as copilotMtime,
} from "../../src/engine/copilot-local/history.ts"

describe("codex latestTranscriptMtimeForWorktree", () => {
  function deps(files: Record<string, { cwd: string; mtimeMs: number }>): CodexDeps {
    return {
      sessionsDir: () => "/sessions",
      // Single flat day-dir so listRolloutFiles enumerates our files.
      readdir: async (p) => {
        if (p === "/sessions") return ["2026"]
        if (p === "/sessions/2026") return ["05"]
        if (p === "/sessions/2026/05") return ["29"]
        if (p === "/sessions/2026/05/29") return Object.keys(files)
        return []
      },
      readFile: async (p) => {
        const name = path.basename(p)
        const f = files[name]
        if (!f) throw new Error("missing")
        return JSON.stringify({ type: "session_meta", payload: { cwd: f.cwd } })
      },
      stat: async (p) => {
        const name = path.basename(p)
        return { mtimeMs: files[name]?.mtimeMs ?? 0 }
      },
    }
  }

  it("returns the newest-mtime rollout matching the worktree cwd, skipping other worktrees", async () => {
    const files = {
      "rollout-2026-05-29T01-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl": { cwd: "/wt", mtimeMs: 1000 },
      "rollout-2026-05-29T02-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl": { cwd: "/wt", mtimeMs: 2000 },
      "rollout-2026-05-29T03-00-00-cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl": { cwd: "/other", mtimeMs: 3000 },
    }
    // Newest filename (03:00, /other) belongs to another worktree and is
    // skipped; the max mtime among /wt's rollouts is 02:00's 2000.
    expect(await codexMtime("/wt", deps(files))).toBe(2000)
  })

  it("returns the max mtime even when an older-by-filename rollout is the active one", async () => {
    // Filename order is CREATION order. A resumed older session appended to
    // after a newer, idle rollout was created carries the higher mtime — the
    // Ops badge and turn detector want that newest ACTIVITY, i.e. the max
    // mtime, not whichever rollout was created most recently. This mirrors
    // the Claude/Copilot readers. The pre-fix "first cwd match by filename"
    // returned the newer-but-idle 3000-mtime file's 3000 here.
    const files = {
      // Older filename, but the session the agent is actively appending to.
      "rollout-2026-05-29T01-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl": { cwd: "/wt", mtimeMs: 9000 },
      // Newer filename, idle since creation.
      "rollout-2026-05-29T02-00-00-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl": { cwd: "/wt", mtimeMs: 3000 },
    }
    expect(await codexMtime("/wt", deps(files))).toBe(9000)
    // findLatestRolloutForWorktree surfaces the PATH of that active rollout —
    // the file the turn detector then reads for the completion marker.
    const found = await codexFindLatest("/wt", deps(files))
    expect(found?.mtimeMs).toBe(9000)
    expect(found?.path).toContain("rollout-2026-05-29T01-00-00-aaaaaaaa")
  })

  it("returns 0 when no rollout matches the worktree", async () => {
    const files = {
      "rollout-2026-05-29T01-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl": { cwd: "/other", mtimeMs: 1000 },
    }
    expect(await codexMtime("/wt", deps(files))).toBe(0)
  })

  it("returns 0 for an empty worktree", async () => {
    expect(await codexMtime("", deps({}))).toBe(0)
  })
})

describe("copilot latestTranscriptMtimeForWorktree", () => {
  function deps(sessions: Record<string, { cwd: string; eventsMtime: number }>): CopilotHistoryDeps {
    return {
      copilotDir: () => "/home/.copilot",
      readdir: async (p) => (p.endsWith("session-state") ? Object.keys(sessions) : []),
      readFile: async (p) => {
        const dir = path.basename(path.dirname(p))
        const s = sessions[dir]
        if (!s || !p.endsWith("workspace.yaml")) throw new Error("missing")
        return `id: ${dir}\ncwd: ${s.cwd}\n`
      },
      stat: async (p) => {
        const dir = path.basename(path.dirname(p))
        const s = sessions[dir]
        if (!s || !p.endsWith("events.jsonl")) throw new Error("missing")
        return { mtimeMs: s.eventsMtime }
      },
      rm: async () => {},
    }
  }

  it("returns the newest events.jsonl mtime among matching sessions", async () => {
    const sessions = {
      older: { cwd: "/wt", eventsMtime: 1000 },
      newer: { cwd: "/wt", eventsMtime: 5000 },
      other: { cwd: "/elsewhere", eventsMtime: 9000 },
    }
    expect(await copilotMtime("/wt", deps(sessions))).toBe(5000)
  })

  it("returns 0 when no session matches", async () => {
    expect(await copilotMtime("/wt", deps({ a: { cwd: "/x", eventsMtime: 1 } }))).toBe(0)
  })
})

describe("claude latestTranscriptMtimeForWorktree", () => {
  it("returns the newest session-file mtime for the worktree", async () => {
    // Claude encodes the worktree cwd as the projects subdir name
    // (`/`→`-`), and its lister reads ~/.claude/projects. Point HOME at
    // a temp dir and build that layout for a fake worktree path.
    const home = await mkdtemp(path.join(tmpdir(), "kobe-claude-mtime-"))
    const prevHome = process.env.HOME
    process.env.HOME = home
    try {
      const worktree = "/tmp/kobe-fake-wt"
      const encoded = worktree.replace(/\//g, "-")
      const projDir = path.join(home, ".claude", "projects", encoded)
      const { mkdir } = await import("node:fs/promises")
      await mkdir(projDir, { recursive: true })
      const oldFile = path.join(projDir, "old.jsonl")
      const newFile = path.join(projDir, "new.jsonl")
      await writeFile(oldFile, "{}\n")
      await writeFile(newFile, "{}\n")
      const oldTime = new Date(2026, 0, 1)
      const newTime = new Date(2026, 5, 1)
      await utimes(oldFile, oldTime, oldTime)
      await utimes(newFile, newTime, newTime)

      expect(await claudeMtime(worktree)).toBe(newTime.getTime())
      expect(await claudeMtime("/tmp/never-entered")).toBe(0)
    } finally {
      process.env.HOME = prevHome
    }
  })
})
