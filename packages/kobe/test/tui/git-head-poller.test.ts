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
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
  return dir
}

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
    expect(count()).toBe(afterFirst)
  })

  test("a checkout (HEAD rewrite) busts the gate and re-resolves", async () => {
    const repo = makeRepo()
    const { spawn, count } = countingSpawn()
    const signal = new AbortController().signal

    expect(await resolveBranchHead(repo, signal, spawn)).toBe("main")
    const afterFirst = count()

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
    expect(count()).toBeGreaterThan(afterFirst)
  })
})
