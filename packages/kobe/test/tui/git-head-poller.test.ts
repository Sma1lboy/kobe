/**
 * Unit tests for the sidebar's git-HEAD branch resolver — specifically the
 * `.git/HEAD` fingerprint gate (waste audit).
 *
 * Why the gate matters: every visible project (main) row fires
 * `pollCurrentBranch(repo)` on the sidebar's ~2s branchTick, daemon-connected
 * or not, forever. Without the gate that's one `git symbolic-ref` subprocess
 * per project per tick (5 projects ≈ 150 spawns/min steady-state) for a value
 * that only changes on a checkout. The branch NAME is a pure function of
 * `.git/HEAD`'s content, so a stat (mtime+size) decides whether git needs to
 * run at all — the steady state is syscalls, with a spawn only on an actual
 * HEAD change. These tests count spawns through the injectable seam to pin
 * that contract.
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { spawnCapture } from "../../src/tui/lib/background-poll"
import { resetGitHeadPoller, resolveBranchHead } from "../../src/tui/panes/sidebar/git-head"

afterEach(() => resetGitHeadPoller())

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kobe-git-head-"))
  // -b main pins the initial branch name across git default-branch configs.
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
  return dir
}

/** Real spawnCapture wrapped with a counter, matching the injection seam. */
function countingSpawn(): { spawn: typeof spawnCapture; count: () => number } {
  let n = 0
  const spawn: typeof spawnCapture = (cmd, args, opts) => {
    n++
    return spawnCapture(cmd, args, opts)
  }
  return { spawn, count: () => n }
}

describe("resolveBranchHead fingerprint gate", () => {
  test("second resolve with an unchanged HEAD spawns nothing and returns the cached name", async () => {
    const repo = makeRepo()
    const { spawn, count } = countingSpawn()
    const signal = new AbortController().signal

    expect(await resolveBranchHead(repo, signal, spawn)).toBe("main")
    const afterFirst = count()
    expect(afterFirst).toBeGreaterThanOrEqual(1)

    expect(await resolveBranchHead(repo, signal, spawn)).toBe("main")
    expect(count()).toBe(afterFirst) // gate hit — zero new subprocesses
  })

  test("a checkout (HEAD rewrite) busts the gate and re-resolves", async () => {
    const repo = makeRepo()
    const { spawn, count } = countingSpawn()
    const signal = new AbortController().signal

    expect(await resolveBranchHead(repo, signal, spawn)).toBe("main")
    const afterFirst = count()

    // Branch name length differs from "main", so even an identical mtime
    // (coarse-granularity filesystems) changes the size half of the
    // fingerprint — the gate must re-resolve.
    execFileSync("git", ["checkout", "-q", "-b", "feature/longer-name"], { cwd: repo })

    expect(await resolveBranchHead(repo, signal, spawn)).toBe("feature/longer-name")
    expect(count()).toBeGreaterThan(afterFirst)
  })

  test("a repo without a statable .git/HEAD skips the gate (always resolves, returns '')", async () => {
    const missing = join(tmpdir(), "kobe-git-head-definitely-missing")
    const { spawn, count } = countingSpawn()
    const signal = new AbortController().signal

    expect(await resolveBranchHead(missing, signal, spawn)).toBe("")
    const afterFirst = count()
    expect(afterFirst).toBeGreaterThanOrEqual(1)

    // No fingerprint → nothing was cached → the next call resolves again
    // (the old always-spawn behavior is preserved verbatim for this path).
    expect(await resolveBranchHead(missing, signal, spawn)).toBe("")
    expect(count()).toBeGreaterThan(afterFirst)
  })

  test("resetGitHeadPoller clears the fingerprint cache", async () => {
    const repo = makeRepo()
    const { spawn, count } = countingSpawn()
    const signal = new AbortController().signal

    await resolveBranchHead(repo, signal, spawn)
    const afterFirst = count()
    resetGitHeadPoller()
    await resolveBranchHead(repo, signal, spawn)
    expect(count()).toBeGreaterThan(afterFirst) // cache gone → spawned again
  })
})
