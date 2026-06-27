import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type HistoryDeps, appendInterruptedUserPrompt, encodeCwd } from "../../src/engine/claude-code-local/history.ts"
import * as fileBounds from "../../src/engine/file-bounds.ts"

/**
 * Fix R — the rescued-prompt writer must be append-only.
 *
 * `appendInterruptedUserPrompt` runs from `engine.stop`, while the claude
 * subprocess we just SIGTERM'd may still be flushing buffered records to
 * the same JSONL. The old implementation read the whole file into memory,
 * spliced, and `writeFile`-rewrote it — clobbering anything flushed after
 * the read snapshot. These tests prove the writer now only ever appends:
 * a record a "concurrent writer" lands between the read and the write is
 * preserved, and existing bytes are never truncated.
 */

const CWD = "/Users/test/proj"

async function makeDeps(): Promise<{ deps: HistoryDeps; projectsRoot: string; filePath: (sid: string) => string }> {
  const projectsRoot = await mkdtemp(path.join(tmpdir(), "kobe-hist-"))
  await mkdir(path.join(projectsRoot, encodeCwd(CWD)), { recursive: true })
  const deps: HistoryDeps = {
    projectsDir: () => projectsRoot,
    readdir: async () => [],
    readFile: async () => "",
    pathExists: async () => true,
  }
  const filePath = (sid: string) => path.join(projectsRoot, encodeCwd(CWD), `${sid}.jsonl`)
  return { deps, projectsRoot, filePath }
}

function userRecord(content: string, uuid: string, parentUuid: string | null = null): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content },
    uuid,
    parentUuid,
    sessionId: "s",
    cwd: CWD,
    timestamp: "2026-06-26T00:00:00.000Z",
    isSidechain: false,
    userType: "external",
    version: "1.0.0",
  })
}

function assistantRecord(content: string, uuid: string, parentUuid: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content },
    uuid,
    parentUuid,
    sessionId: "s",
    timestamp: "2026-06-26T00:00:05.000Z",
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("appendInterruptedUserPrompt — append-only", () => {
  it("records the interrupted prompt when the session file does not yet exist", async () => {
    const { deps, filePath } = await makeDeps()
    await appendInterruptedUserPrompt("s", CWD, "rescued prompt", deps)

    const raw = await readFile(filePath("s"), "utf8")
    const records = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(records).toHaveLength(1)
    expect(records[0].type).toBe("user")
    expect(records[0].message.content).toBe("rescued prompt")
  })

  it("never truncates existing records — the prior content survives verbatim", async () => {
    const { deps, filePath } = await makeDeps()
    // Seed a prior assistant turn (the append-fresh path) plus an unrelated
    // tool-result-ish line we want to be certain is untouched.
    const prior = `${assistantRecord("hi", "a1", "u0")}\n{"type":"summary","summary":"x"}\n`
    await writeFile(filePath("s"), prior)

    await appendInterruptedUserPrompt("s", CWD, "next prompt", deps)

    const raw = await readFile(filePath("s"), "utf8")
    // Original bytes are an exact prefix → nothing was rewritten/truncated.
    expect(raw.startsWith(prior)).toBe(true)
    const records = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(records).toHaveLength(3)
    expect(records[2].message.content).toBe("next prompt")
    // Chained to the assistant turn.
    expect(records[2].parentUuid).toBe("a1")
  })

  it("does NOT lose a record a concurrent writer appends between the read and the write", async () => {
    const { deps, filePath } = await makeDeps()
    // Merge case: last conversational record is a user turn (a prior rescue
    // with no assistant reply yet) — the exact path that used to rewrite the
    // whole file.
    const seed = `${userRecord("first rescued", "u1", "p0")}\n`
    await writeFile(filePath("s"), seed)

    // Simulate claude flushing a buffered assistant reply in the stop window:
    // inject the append AFTER appendInterruptedUserPrompt takes its read
    // snapshot but BEFORE it writes. We do that by wrapping the bounded read.
    const concurrent = `${assistantRecord("flushed reply", "a9", "u1")}\n`
    const realRead = fileBounds.readTextFileBounded
    const spy = vi.spyOn(fileBounds, "readTextFileBounded").mockImplementation(async (p: string, max?: number) => {
      const snapshot = await realRead(p, max)
      // Concurrent writer lands right after our snapshot is taken.
      await appendFile(p, concurrent)
      return snapshot
    })

    await appendInterruptedUserPrompt("s", CWD, "second rescued", deps)
    expect(spy).toHaveBeenCalled()

    const raw = await readFile(filePath("s"), "utf8")
    const records = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    // 1) the seed survives, 2) the concurrently-flushed reply is NOT lost,
    // 3) the rescue is recorded.
    const contents = records.map((r) => r.message.content)
    expect(contents).toContain("first rescued")
    expect(contents).toContain("flushed reply")
    // The rescue coalesces the prior un-replied user turn's text forward.
    expect(contents).toContain("first rescued\n\nsecond rescued")
    expect(records).toHaveLength(3)
  })

  it("coalesces an un-replied user turn as a same-parent sibling (no back-to-back user turns)", async () => {
    const { deps, filePath } = await makeDeps()
    await writeFile(filePath("s"), `${userRecord("turn one", "u1", "rootParent")}\n`)

    await appendInterruptedUserPrompt("s", CWD, "turn two", deps)

    const raw = await readFile(filePath("s"), "utf8")
    const records = raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
    expect(records).toHaveLength(2)
    const appended = records[1]
    expect(appended.message.content).toBe("turn one\n\nturn two")
    // Same parent as the superseded turn → claude --resume follows the newest
    // leaf and sees ONE user turn, not two back-to-back user records.
    expect(appended.parentUuid).toBe("rootParent")
  })

  it("is idempotent — skips when the last user record already ends with the prompt", async () => {
    const { deps, filePath } = await makeDeps()
    await writeFile(filePath("s"), `${userRecord("a\n\nalready here", "u1", "p0")}\n`)

    await appendInterruptedUserPrompt("s", CWD, "already here", deps)

    const raw = await readFile(filePath("s"), "utf8")
    const records = raw.split("\n").filter(Boolean)
    expect(records).toHaveLength(1)
  })
})
