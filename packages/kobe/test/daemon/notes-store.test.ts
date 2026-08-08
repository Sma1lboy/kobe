/**
 * NotesStore tests — the durable half of field notes. Pins: append-only
 * newest-first ordering, retention eviction at the cap, and the git
 * common-dir key so a worktree and its source checkout share one record.
 */

import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type FieldNote, NOTES_RETENTION_CAP, NotesStore } from "@sma1lboy/kobe-daemon/daemon/notes-store"
import { afterEach, describe, expect, it } from "vitest"

const cleanups: string[] = []

async function makeRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "kobe-notes-store-"))
  cleanups.push(repo)
  execFileSync("git", ["init", "--quiet"], { cwd: repo })
  await writeFile(join(repo, "README.md"), "fixture\n", "utf8")
  execFileSync("git", ["add", "."], { cwd: repo })
  execFileSync(
    "git",
    ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "--quiet", "-m", "fixture"],
    { cwd: repo },
  )
  return repo
}

function note(text: string): FieldNote {
  return { at: "2026-08-08T00:00:00.000Z", text, taskId: "t1", author: "worker" }
}

afterEach(async () => {
  while (cleanups.length) await rm(cleanups.pop()!, { recursive: true, force: true })
})

describe("NotesStore", () => {
  it("returns nothing for a repo that never filed a note", async () => {
    const repo = await makeRepo()
    const store = new NotesStore(join(repo, "home", ".kobe", "notes.json"))
    expect(await store.list(repo)).toEqual([])
  })

  it("appends newest-first so recall reads as a recency-ordered list", async () => {
    const repo = await makeRepo()
    const store = new NotesStore(join(repo, "home", ".kobe", "notes.json"))
    await store.append(repo, note("first"))
    await store.append(repo, note("second"))
    expect((await store.list(repo)).map((n) => n.text)).toEqual(["second", "first"])
  })

  it("evicts past the retention cap instead of growing without bound", async () => {
    const repo = await makeRepo()
    const store = new NotesStore(join(repo, "home", ".kobe", "notes.json"))
    for (let i = 0; i < NOTES_RETENTION_CAP + 5; i++) await store.append(repo, note(`n${i}`))
    const notes = await store.list(repo)
    expect(notes).toHaveLength(NOTES_RETENTION_CAP)
    expect(notes[0].text).toBe(`n${NOTES_RETENTION_CAP + 4}`)
    expect(notes.some((n) => n.text === "n0")).toBe(false)
  })

  it("shares one record between a repo and its worktrees (git common-dir key)", async () => {
    const repo = await makeRepo()
    const parent = await mkdtemp(join(tmpdir(), "kobe-notes-wt-"))
    cleanups.push(parent)
    const worktree = join(parent, "task")
    execFileSync("git", ["worktree", "add", "--quiet", worktree, "-b", "task"], { cwd: repo })

    const store = new NotesStore(join(parent, "home", ".kobe", "notes.json"))
    await store.append(worktree, note("filed from the worktree"))
    expect((await store.list(repo)).map((n) => n.text)).toEqual(["filed from the worktree"])
  })

  it("rejects a plain directory rather than silently writing a bogus record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kobe-notes-plain-"))
    cleanups.push(dir)
    const store = new NotesStore(join(dir, "home", ".kobe", "notes.json"))
    await expect(store.append(dir, note("x"))).rejects.toThrow()
  })
})
