import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isJsonlLineWithinBound, readTextFileBounded, readTextFileSyncBounded } from "../../src/engine/file-bounds.ts"

describe("file-bounds", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "kobe-file-bounds-"))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  describe("readTextFileBounded (async)", () => {
    it("returns the file contents when within the byte bound", async () => {
      const p = join(dir, "small.jsonl")
      await writeFile(p, "hello\nworld")
      expect(await readTextFileBounded(p, 1024)).toBe("hello\nworld")
    })

    it("degrades an oversize file to '' instead of slurping it", async () => {
      const p = join(dir, "big.jsonl")
      await writeFile(p, "x".repeat(64))
      expect(await readTextFileBounded(p, 16)).toBe("")
    })

    it("propagates ENOENT so the caller can degrade (matches existing catch paths)", async () => {
      await expect(readTextFileBounded(join(dir, "nope.jsonl"))).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  describe("readTextFileSyncBounded (credentials)", () => {
    it("returns the contents when within the byte bound", async () => {
      const p = join(dir, "auth.json")
      await writeFile(p, '{"k":1}')
      expect(readTextFileSyncBounded(p, 1024)).toBe('{"k":1}')
    })

    it("returns null (the 'not detected' shape) for an oversize file — never throws, never logs", async () => {
      const p = join(dir, "fat.json")
      await writeFile(p, "y".repeat(100))
      expect(readTextFileSyncBounded(p, 10)).toBeNull()
    })

    it("returns null for a missing file", () => {
      expect(readTextFileSyncBounded(join(dir, "absent.json"))).toBeNull()
    })
  })

  describe("isJsonlLineWithinBound", () => {
    it("accepts a normal line and rejects a mega-line", () => {
      expect(isJsonlLineWithinBound("a".repeat(100), 1000)).toBe(true)
      expect(isJsonlLineWithinBound("a".repeat(1001), 1000)).toBe(false)
    })
  })
})
