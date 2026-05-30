import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { LockfileError, acquire, isProcessAlive, release } from "../../src/orchestrator/index/lockfile.ts"

describe("isProcessAlive", () => {
  it("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it("rejects non-positive / non-integer pids without throwing", () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
    expect(isProcessAlive(1.5)).toBe(false)
  })

  it("returns false for a pid far above the typical max", () => {
    expect(isProcessAlive(999_999)).toBe(false)
  })
})

describe("acquire / release", () => {
  let dir: string
  let lock: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kobe-lock-"))
    lock = join(dir, "index.lock")
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it("creates a lockfile holding our pid, then releases it idempotently", async () => {
    await acquire(lock)
    expect((await readFile(lock, "utf8")).trim()).toBe(String(process.pid))
    await release(lock)
    // A second release of an already-gone lock must not throw.
    await expect(release(lock)).resolves.toBeUndefined()
  })

  it("rejects with LockfileError when held by a live process", async () => {
    await acquire(lock) // held by us — alive
    await expect(acquire(lock)).rejects.toBeInstanceOf(LockfileError)
  })

  it("steals a stale lockfile whose holder is gone", async () => {
    await writeFile(lock, "999999") // a pid that does not exist
    await expect(acquire(lock)).resolves.toBeUndefined()
    expect((await readFile(lock, "utf8")).trim()).toBe(String(process.pid))
  })

  it("forceTakeover steals from a live holder", async () => {
    await acquire(lock) // held by us — alive
    await expect(acquire(lock, { forceTakeover: true })).resolves.toBeUndefined()
    expect((await readFile(lock, "utf8")).trim()).toBe(String(process.pid))
  })
})
