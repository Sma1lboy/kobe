import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  MIN_POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  SLOW_REPO_RETRY_MS,
  nextAllowedAt,
  pollWorktreeChanges,
  resetWorktreeChangesPoller,
  shouldPoll,
  worktreeChanges,
} from "../../src/tui/panes/sidebar/worktree-changes-poller"

afterEach(() => resetWorktreeChangesPoller())

describe("shouldPoll", () => {
  test("dedupes while a poll is in flight — a tick landing mid-status is dropped", () => {
    expect(shouldPoll({ inFlight: true, nextAllowedAt: 0 }, 1_000)).toBe(false)
  })

  test("respects the backoff window, then allows again", () => {
    const state = { inFlight: false, nextAllowedAt: 5_000 }
    expect(shouldPoll(state, 4_999)).toBe(false)
    expect(shouldPoll(state, 5_000)).toBe(true)
  })
})

describe("nextAllowedAt", () => {
  test("fast repos keep the tick cadence (floor = MIN_POLL_INTERVAL_MS)", () => {
    expect(nextAllowedAt(10_000, 10_050, false)).toBe(10_050 + MIN_POLL_INTERVAL_MS)
  })

  test("slow-but-finishing repos self-thin at 5× their own duration", () => {
    expect(nextAllowedAt(10_000, 13_000, false)).toBe(13_000 + 15_000)
  })

  test("timed-out repos back off hard from the START time", () => {
    expect(nextAllowedAt(10_000, 10_000 + POLL_TIMEOUT_MS, true)).toBe(10_000 + SLOW_REPO_RETRY_MS)
  })
})

describe("pollWorktreeChanges end-to-end", () => {
  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "kobe-poller-"))
    execFileSync("git", ["init", "-q"], { cwd: dir })
    return dir
  }

  async function waitFor(predicate: () => boolean, ms = 3_000): Promise<void> {
    const deadline = Date.now() + ms
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for poll result")
      await new Promise((r) => setTimeout(r, 25))
    }
  }

  test("async poll reports untracked files without blocking the caller", async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, "a.txt"), "hello")
    writeFileSync(join(repo, "b.txt"), "world")
    expect(worktreeChanges(repo)).toEqual({ added: 0, deleted: 0 })
    pollWorktreeChanges(repo)
    await waitFor(() => worktreeChanges(repo).added === 2)
    expect(worktreeChanges(repo)).toEqual({ added: 2, deleted: 0 })
  })

  test("a failing path keeps the last value instead of erroring", async () => {
    const missing = join(tmpdir(), "kobe-poller-definitely-missing")
    pollWorktreeChanges(missing)
    await new Promise((r) => setTimeout(r, 150))
    expect(worktreeChanges(missing)).toEqual({ added: 0, deleted: 0 })
  })

  test("empty path is a no-op", () => {
    pollWorktreeChanges("")
    expect(worktreeChanges("")).toEqual({ added: 0, deleted: 0 })
  })
})
