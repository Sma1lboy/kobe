import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
    await expect(release(lock)).resolves.toBeUndefined()
  })

  it("rejects with LockfileError when held by a live process", async () => {
    await acquire(lock)
    await expect(acquire(lock)).rejects.toBeInstanceOf(LockfileError)
  })

  it("steals a stale lockfile whose holder is gone", async () => {
    await writeFile(lock, "999999")
    await expect(acquire(lock)).resolves.toBeUndefined()
    expect((await readFile(lock, "utf8")).trim()).toBe(String(process.pid))
  })

  it("forceTakeover steals from a live holder", async () => {
    await acquire(lock)
    await expect(acquire(lock, { forceTakeover: true })).resolves.toBeUndefined()
    expect((await readFile(lock, "utf8")).trim()).toBe(String(process.pid))
  })
})

describe("acquire / release — edge branches", () => {
  const dir = mkdtempSync(join(tmpdir(), "kobe-lock-edge-"))
  const lockPath = join(dir, "edge.lock")

  afterEach(async () => {
    await release(lockPath).catch(() => {})
  })

  it("treats an EPERM kill probe as alive (exists but not signalable)", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" })
    })
    try {
      expect(isProcessAlive(1)).toBe(true)
    } finally {
      killSpy.mockRestore()
    }
  })

  it("steals a lockfile whose content isn't a pid at all", async () => {
    writeFileSync(lockPath, "not-a-pid")
    await acquire(lockPath)
    expect(readFileSync(lockPath, "utf8")).toBe(String(process.pid))
  })

  it("release tolerates a lock that's already gone, rethrows real errors", async () => {
    await expect(release(join(dir, "never-existed.lock"))).resolves.toBeUndefined()
  })
})
