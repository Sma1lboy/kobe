/**
 * Field-note reader tests — the launch path's view of the daemon-owned
 * store. Pins: repoRoot matching, the injection cap, and total tolerance of
 * a missing/garbage store (a knowledge feature must never block a launch).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { NOTE_INJECTION_CAP, readFieldNotes } from "../../src/state/field-notes.ts"

const cleanups: string[] = []

async function storeWith(repos: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "kobe-field-notes-"))
  cleanups.push(dir)
  const path = join(dir, "notes.json")
  await writeFile(path, JSON.stringify({ version: 1, repos }), "utf8")
  return path
}

afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true })
})

describe("readFieldNotes", () => {
  it("returns the matching repo's notes and ignores other repos in the same file", async () => {
    const path = await storeWith({
      keyA: { repoRoot: "/repo/a", notes: [{ at: "", text: "a-note", taskId: "t", author: "w" }] },
      keyB: { repoRoot: "/repo/b", notes: [{ at: "", text: "b-note", taskId: "t", author: "w" }] },
    })
    expect(readFieldNotes("/repo/b", path).map((n) => n.text)).toEqual(["b-note"])
  })

  it("caps how many notes reach a prompt", async () => {
    const notes = Array.from({ length: NOTE_INJECTION_CAP + 10 }, (_, i) => ({
      at: "",
      text: `n${i}`,
      taskId: "t",
      author: "w",
    }))
    const path = await storeWith({ k: { repoRoot: "/repo/a", notes } })
    expect(readFieldNotes("/repo/a", path)).toHaveLength(NOTE_INJECTION_CAP)
  })

  it("is empty for an unknown repo, an empty repoRoot, and a missing file", async () => {
    const path = await storeWith({ k: { repoRoot: "/repo/a", notes: [{ at: "", text: "x", taskId: "", author: "" }] } })
    expect(readFieldNotes("/repo/zzz", path)).toEqual([])
    expect(readFieldNotes("", path)).toEqual([])
    expect(readFieldNotes("/repo/a", join(tmpdir(), "kobe-no-such-notes.json"))).toEqual([])
  })

  it("survives a corrupt store rather than throwing into the launch path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kobe-field-notes-bad-"))
    cleanups.push(dir)
    const path = join(dir, "notes.json")
    await writeFile(path, "{ not json", "utf8")
    expect(readFieldNotes("/repo/a", path)).toEqual([])
  })

  it("drops malformed entries instead of surfacing textless notes", async () => {
    const path = await storeWith({
      k: { repoRoot: "/repo/a", notes: [null, { at: "" }, { at: "", text: "real", taskId: "t", author: "w" }] },
    })
    expect(readFieldNotes("/repo/a", path).map((n) => n.text)).toEqual(["real"])
  })
})
