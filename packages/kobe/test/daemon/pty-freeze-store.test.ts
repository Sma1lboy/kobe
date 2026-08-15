/**
 * Freeze/restore store (`pty-freeze-store.ts`) — the persistence half of
 * "a pty-host restart must not take the work scene with it". One JSON file
 * per session; the pins here are the round-trip, the corruption/malformed
 * tolerance (a bad file must never block the OTHER sessions' restore), the
 * ring cap on thaw, and the reset semantics (clear = starts fresh).
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type FreezeableSession,
  type FrozenPtySession,
  clearFrozenSessions,
  fileFreezeSink,
  freezeSession,
  loadFrozenSessions,
  thawRing,
  thawSession,
} from "@sma1lboy/kobe-daemon/daemon/pty-freeze-store"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kobe-pty-freeze-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function fakeSession(over: Partial<FreezeableSession> = {}): FreezeableSession {
  return {
    key: "t1::tab-1",
    cwd: "/wt/t1",
    command: ["/bin/zsh", "-ilc", "claude --session-id abc"],
    cols: 120,
    rows: 40,
    title: "claude",
    totalBytes: 11,
    exit: null,
    chunks: [Buffer.from("hello "), Buffer.from("world")],
    bytes: 11,
    ...over,
  }
}

describe("pty freeze store", () => {
  it("round-trips a session: metadata + scrollback + offsets survive", () => {
    const sink = fileFreezeSink(dir)
    sink.save(freezeSession(fakeSession()))
    const [record] = loadFrozenSessions(dir)
    expect(record).toMatchObject({
      v: 1,
      key: "t1::tab-1",
      cwd: "/wt/t1",
      command: ["/bin/zsh", "-ilc", "claude --session-id abc"],
      cols: 120,
      rows: 40,
      title: "claude",
      totalBytes: 11,
      exit: null,
    })
    expect(Buffer.from(record.ringB64, "base64").toString("utf8")).toBe("hello world")

    const thawed = thawSession(record, 512 * 1024)
    expect(thawed).toMatchObject({ key: "t1::tab-1", alive: false, restored: true, bytes: 11, totalBytes: 11 })
    expect(Buffer.concat(thawed?.chunks ?? []).toString("utf8")).toBe("hello world")
  })

  it("encodes :: keys into filesystem-safe, per-session filenames", () => {
    const sink = fileFreezeSink(dir)
    sink.save(freezeSession(fakeSession({ key: "t1::tab-1" })))
    sink.save(freezeSession(fakeSession({ key: "t1::tab-1::leaf-2" })))
    const names = readdirSync(dir)
    expect(names.length).toBe(2)
    for (const name of names) expect(name).toMatch(/^[^/\\:]+\.json$/)
    expect(
      loadFrozenSessions(dir)
        .map((r) => r.key)
        .sort(),
    ).toEqual(["t1::tab-1", "t1::tab-1::leaf-2"])
  })

  it("a corrupt or foreign-version file reads as absent and never blocks the rest", () => {
    const sink = fileFreezeSink(dir)
    sink.save(freezeSession(fakeSession({ key: "good::tab-1" })))
    writeFileSync(join(dir, "broken.json"), "{not json", "utf8")
    writeFileSync(
      join(dir, "future.json"),
      JSON.stringify({ ...freezeSession(fakeSession({ key: "x::tab-1" })), v: 99 }),
      "utf8",
    )
    writeFileSync(join(dir, "internal.json"), JSON.stringify(freezeSession(fakeSession({ key: "::spare" }))), "utf8")
    expect(loadFrozenSessions(dir).map((r) => r.key)).toEqual(["good::tab-1"])
  })

  it("drop removes exactly one session; clear wipes the store (rove reset)", () => {
    const sink = fileFreezeSink(dir)
    sink.save(freezeSession(fakeSession({ key: "t1::tab-1" })))
    sink.save(freezeSession(fakeSession({ key: "t2::tab-1" })))
    sink.drop("t1::tab-1")
    expect(loadFrozenSessions(dir).map((r) => r.key)).toEqual(["t2::tab-1"])
    clearFrozenSessions(dir)
    expect(loadFrozenSessions(dir)).toEqual([])
    // clear on an absent dir is fine, and drop never throws past the sink.
    clearFrozenSessions(dir)
    sink.drop("never-existed")
  })

  it("thawRing trims an oversized ring to the cap's TAIL (the reattach repaint)", () => {
    const big = Buffer.alloc(1024, 0x61)
    const record = freezeSession(fakeSession({ chunks: [big], bytes: 1024, totalBytes: 2048 }))
    const ring = thawRing(record, 256)
    expect(ring?.bytes).toBe(256)
    // totalBytes stays monotonic from the record, not the trimmed window.
    const thawed = thawSession(record, 256)
    expect(thawed?.totalBytes).toBe(2048)
  })

  it("thaw tolerates a garbage ring — no throw, and the session still restores", () => {
    // Buffer.from(…, "base64") never throws: it decodes the valid subset.
    // The pin is that a weird ring can never crash the restore path.
    const record: FrozenPtySession = { ...freezeSession(fakeSession()), ringB64: "%%%" }
    const thawed = thawSession(record, 1024)
    expect(thawed?.restored).toBe(true)
    expect(thawed?.bytes).toBe(0)
  })
})
