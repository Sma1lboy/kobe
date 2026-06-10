/**
 * Cost-summary parity through the engine registry (KOB-230).
 *
 * monitor/cost.ts used to import claude's `listSessionFilesForWorktree`
 * directly and parse the JSONL inline; the parsing now lives in
 * `engine/claude-code-local/cost.ts` behind the registry's
 * `summarizeCost` entry. These tests pin:
 *
 *  - claude (and the no-vendor default, which is claude): identical
 *    lifetime sums over every transcript's per-message `usage`;
 *  - vendors WITHOUT a wired cost reader (codex/copilot/custom): zeros,
 *    never claude's numbers — adding codex cost later is one registry
 *    entry (KOB-232), not a change here.
 *
 * Claude's lister stats the real filesystem rooted at `homedir()`, so we
 * point $HOME at a temp dir.
 */

import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { encodeCwd } from "../../src/engine/claude-code-local/history.ts"
import { summarizeTaskCost } from "../../src/monitor/cost.ts"

const WORKTREE = "/work/tree"

let home: string
let savedHome: string | undefined

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "kobe-cost-"))
  savedHome = process.env.HOME
  process.env.HOME = home
})

afterEach(() => {
  process.env.HOME = savedHome
})

function usageLine(usage: Record<string, number>): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: "x", usage } })
}

async function writeSession(sessionId: string, lines: string[], mtimeSec: number): Promise<void> {
  const dir = path.join(home, ".claude", "projects", encodeCwd(WORKTREE))
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `${sessionId}.jsonl`)
  await writeFile(file, `${lines.join("\n")}\n`)
  await utimes(file, mtimeSec, mtimeSec)
}

describe("summarizeTaskCost (claude through the registry)", () => {
  it("sums usage cumulatively across every session transcript", async () => {
    await writeSession(
      "s1",
      [
        usageLine({ input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 }),
        "not json at all", // skipped, never throws
        usageLine({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 7 }),
        JSON.stringify({ type: "user", message: { role: "user", content: "no usage" } }),
      ],
      1_000,
    )
    await writeSession("s2", [usageLine({ input_tokens: 100, output_tokens: 200 })], 2_000)

    const summary = await summarizeTaskCost({ taskId: "t1", worktree: WORKTREE })
    expect(summary).toEqual({
      taskId: "t1",
      worktree: WORKTREE,
      sessionCount: 2,
      inputTokens: 111,
      outputTokens: 222,
      cacheReadTokens: 5,
      cacheCreateTokens: 7,
      // newest file's mtime (utimes takes seconds; mtimeMs is ms)
      lastActivityMs: 2_000_000,
    })
  })

  it("returns zeros when the task was never entered", async () => {
    const summary = await summarizeTaskCost({ taskId: "t1", worktree: WORKTREE })
    expect(summary.sessionCount).toBe(0)
    expect(summary.inputTokens).toBe(0)
    expect(summary.lastActivityMs).toBeNull()
  })

  it("explicit vendor 'claude' matches the default-vendor path", async () => {
    await writeSession("s1", [usageLine({ input_tokens: 3, output_tokens: 4 })], 1_000)
    const byDefault = await summarizeTaskCost({ taskId: "t1", worktree: WORKTREE })
    const explicit = await summarizeTaskCost({ taskId: "t1", worktree: WORKTREE, vendor: "claude" })
    expect(explicit).toEqual(byDefault)
    expect(explicit.inputTokens).toBe(3)
  })
})

describe("summarizeTaskCost (vendors without a cost reader)", () => {
  it("returns zeros for codex/copilot/custom even when claude transcripts exist", async () => {
    await writeSession("s1", [usageLine({ input_tokens: 10, output_tokens: 20 })], 1_000)
    for (const vendor of ["codex", "copilot", "my-custom-engine"]) {
      const summary = await summarizeTaskCost({ taskId: "t1", worktree: WORKTREE, vendor })
      expect(summary).toEqual({
        taskId: "t1",
        worktree: WORKTREE,
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
        lastActivityMs: null,
      })
    }
  })
})
