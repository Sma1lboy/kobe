import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleDiffRequest, mapPool, splitDiffByFile, statusLabel } from "../../src/web/diff.ts"

describe("mapPool", () => {
  it("preserves input → output order regardless of completion order", async () => {
    const items = [50, 10, 30, 0, 20]
    // Faster items resolve first, but results must still line up by index.
    const out = await mapPool(items, 8, async (ms, i) => {
      await new Promise((r) => setTimeout(r, ms))
      return `${i}:${ms}`
    })
    expect(out).toEqual(["0:50", "1:10", "2:30", "3:0", "4:20"])
  })

  it("runs exactly `limit` workers concurrently, never more (deterministic gate)", async () => {
    // Gate every worker on a manually-released promise instead of a
    // wall-clock sleep: the old `peak > 1` assertion raced the scheduler
    // (under load all microtasks could settle serially → peak===1 → flaky
    // red), exactly the "timing never gates CI" rule in docs/HARNESS.md.
    // Here the concurrency is OBSERVED precisely: after one macrotask the
    // pool has spawned its initial cohort and parked it, so inFlight is
    // exactly `limit` — no race, we only wait for already-queued work.
    const release: Array<() => void> = []
    let inFlight = 0
    let peak = 0
    const items = Array.from({ length: 50 }, (_v, i) => i)
    const done = mapPool(items, 8, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise<void>((r) => release.push(r))
      inFlight--
      return n
    })
    const drain = () => new Promise((r) => setTimeout(r, 0))
    await drain()
    expect(inFlight).toBe(8) // exactly `limit` parked — precise, not `> 1`
    // Release in waves; each wave the pool refills to at most `limit`.
    while (release.length > 0) {
      const wave = release.splice(0)
      for (const r of wave) r()
      await drain()
      expect(inFlight).toBeLessThanOrEqual(8)
    }
    expect(await done).toEqual(items)
    expect(peak).toBe(8)
  })

  it("handles an empty input without spawning a worker", async () => {
    let calls = 0
    const out = await mapPool([], 8, async (x) => {
      calls++
      return x
    })
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })

  it("clamps the worker count to the item count for tiny inputs", async () => {
    let peak = 0
    let inFlight = 0
    const out = await mapPool([1, 2], 8, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return n * 10
    })
    expect(out).toEqual([10, 20])
    expect(peak).toBeLessThanOrEqual(2)
  })

  it("treats a limit < 1 as a single worker", async () => {
    let peak = 0
    let inFlight = 0
    await mapPool([1, 2, 3], 0, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return n
    })
    expect(peak).toBe(1)
  })
})

describe("statusLabel", () => {
  it("maps known porcelain codes to human labels", () => {
    expect(statusLabel("M")).toBe("modified")
    expect(statusLabel("A")).toBe("added")
    expect(statusLabel("D")).toBe("deleted")
    expect(statusLabel("R")).toBe("renamed")
    expect(statusLabel("C")).toBe("copied")
    expect(statusLabel("T")).toBe("type changed")
    expect(statusLabel("U")).toBe("unmerged")
    expect(statusLabel("?")).toBe("untracked")
  })

  it("falls back to `changed` for unknown codes", () => {
    expect(statusLabel("X")).toBe("changed")
    expect(statusLabel(" ")).toBe("changed")
  })
})

describe("splitDiffByFile", () => {
  it("returns an empty map for empty input", () => {
    expect(splitDiffByFile("").size).toBe(0)
  })

  it("keys each chunk by its post-image (+++ b/) path", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "index 111..222 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/bar.ts b/bar.ts",
      "index 333..444 100644",
      "--- a/bar.ts",
      "+++ b/bar.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n")
    const byFile = splitDiffByFile(diff)
    expect([...byFile.keys()].sort()).toEqual(["bar.ts", "foo.ts"])
    expect(byFile.get("foo.ts")).toContain("+new")
    expect(byFile.get("bar.ts")).toContain("+b")
    // Each stored chunk is newline-terminated.
    expect(byFile.get("foo.ts")?.endsWith("\n")).toBe(true)
  })

  it("uses the header b/ path for deleted files (+++ /dev/null)", () => {
    const diff = [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "index 555..000",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "",
    ].join("\n")
    const byFile = splitDiffByFile(diff)
    expect(byFile.has("gone.ts")).toBe(true)
    expect(byFile.get("gone.ts")).toContain("-bye")
  })

  it("keys paths containing spaces by their post-image path", () => {
    // Git leaves spaces unquoted but appends a TAB after the name in the
    // `---`/`+++` markers to disambiguate it — that tab is NOT part of the
    // path and must be stripped, else the key never matches the porcelain row.
    const diff = [
      "diff --git a/has space.ts b/has space.ts",
      "index 111..222 100644",
      "--- a/has space.ts\t",
      "+++ b/has space.ts\t",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n")
    const byFile = splitDiffByFile(diff)
    expect([...byFile.keys()]).toEqual(["has space.ts"])
    expect(byFile.get("has space.ts")).toContain("+y")
  })

  it("decodes a C-quoted non-ASCII post-image path (octal byte escapes)", () => {
    // Git C-quotes a path with non-ASCII bytes, octal-escaping each UTF-8 byte
    // and wrapping the whole `b/…` in quotes: `+++ "b/\303\274.txt"` (ü.txt).
    const diff = [
      'diff --git "a/\\303\\274.txt" "b/\\303\\274.txt"',
      "index 111..222 100644",
      '--- "a/\\303\\274.txt"',
      '+++ "b/\\303\\274.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n")
    const byFile = splitDiffByFile(diff)
    expect([...byFile.keys()]).toEqual(["ü.txt"])
    expect(byFile.get("ü.txt")).toContain("+b")
  })

  it("decodes a C-quoted path with a control char (tab in the name)", () => {
    // A genuine tab inside a name forces C-quoting (`"b/a\tb.txt"`); the decoded
    // key carries the literal tab, matching the raw porcelain `-z` path.
    const diff = [
      'diff --git "a/a\\tb.txt" "b/a\\tb.txt"',
      "index 111..222 100644",
      '--- "a/a\\tb.txt"',
      '+++ "b/a\\tb.txt"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n")
    const byFile = splitDiffByFile(diff)
    expect([...byFile.keys()]).toEqual(["a\tb.txt"])
    expect(byFile.get("a\tb.txt")).toContain("+b")
  })

  it("ignores leading content that is not a diff chunk", () => {
    const diff = [
      "warning: some preamble that is not a chunk",
      "diff --git a/x.ts b/x.ts",
      "index 1..2 100644",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-1",
      "+2",
      "",
    ].join("\n")
    const byFile = splitDiffByFile(diff)
    expect([...byFile.keys()]).toEqual(["x.ts"])
  })
})

/**
 * worktreePath is the route's only user input and it feeds `git -C <path>`, so
 * the input guards ARE the security boundary. These cases all return BEFORE any
 * git spawn, so they need no repo. (The happy path needs a real worktree and is
 * exercised end-to-end via the bridge, not here.)
 */
describe("handleDiffRequest — input guards", () => {
  const req = (path: string, method = "GET") => {
    const url = new URL(`http://localhost${path}`)
    return { req: new Request(url, { method }), url }
  }

  it("falls through (null) for a non-diff path", async () => {
    const { req: r, url } = req("/api/notes?taskId=abc")
    expect(await handleDiffRequest(r, url)).toBeNull()
  })

  it("rejects a non-GET method with 405", async () => {
    const { req: r, url } = req("/api/diff?worktreePath=/tmp", "POST")
    expect((await handleDiffRequest(r, url))?.status).toBe(405)
  })

  it("rejects a missing worktreePath with 400", async () => {
    const { req: r, url } = req("/api/diff")
    expect((await handleDiffRequest(r, url))?.status).toBe(400)
  })

  it("rejects a non-absolute worktreePath with 400", async () => {
    for (const bad of ["relative/path", "../../etc", "."]) {
      const { req: r, url } = req(`/api/diff?worktreePath=${encodeURIComponent(bad)}`)
      expect((await handleDiffRequest(r, url))?.status, bad).toBe(400)
    }
  })

  it("rejects a non-existent absolute worktreePath with 400", async () => {
    const { req: r, url } = req("/api/diff?worktreePath=/nonexistent-kobe-diff-test-dir-xyz")
    expect((await handleDiffRequest(r, url))?.status).toBe(400)
  })

  it("rejects a malformed percent-encoded worktreePath with 400", async () => {
    const url = new URL("http://localhost/api/diff?worktreePath=%")
    const r = new Request(url)
    expect((await handleDiffRequest(r, url))?.status).toBe(400)
  })
})

/**
 * End-to-end happy-path coverage against a REAL git repo — this route's whole
 * job is slicing real `git status`/`git diff` output, so a real repo exercises
 * the actual porcelain -z parsing, staged/unstaged merge, and untracked-file
 * synthesized-patch path that the input-guard tests above (by design) never
 * reach.
 */
describe("handleDiffRequest — real repo", () => {
  let dir: string

  function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: dir, encoding: "utf8" })
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-diff-test-"))
    git("init", "-q")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    fs.writeFileSync(path.join(dir, "tracked.txt"), "line one\nline two\n")
    git("add", "tracked.txt")
    git("commit", "-q", "-m", "initial")
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function request(): { req: Request; url: URL } {
    const url = new URL(`http://localhost/api/diff?worktreePath=${encodeURIComponent(dir)}`)
    return { req: new Request(url), url }
  }

  it("returns an empty file list for a clean worktree", async () => {
    const { req, url } = request()
    const res = await handleDiffRequest(req, url)
    expect(res?.status).toBe(200)
    const body = await res!.json()
    expect(body.files).toEqual([])
    expect(body.raw).toBe("")
  })

  it("reports an unstaged modification with its patch and staged:false", async () => {
    fs.writeFileSync(path.join(dir, "tracked.txt"), "line one\nline TWO\n")
    const { req, url } = request()
    const body = await (await handleDiffRequest(req, url))!.json()
    expect(body.files).toEqual([{ path: "tracked.txt", status: "modified", staged: false, patch: expect.any(String) }])
    expect(body.files[0].patch).toContain("+line TWO")
    expect(body.raw).toContain("+line TWO")
  })

  it("reports a staged addition as staged:true", async () => {
    fs.writeFileSync(path.join(dir, "staged.txt"), "hello\n")
    git("add", "staged.txt")
    const { req, url } = request()
    const body = await (await handleDiffRequest(req, url))!.json()
    expect(body.files).toEqual([{ path: "staged.txt", status: "added", staged: true, patch: expect.any(String) }])
    expect(body.files[0].patch).toContain("+hello")
  })

  it("synthesizes an all-added patch for an untracked file", async () => {
    fs.writeFileSync(path.join(dir, "new.txt"), "brand new\n")
    const { req, url } = request()
    const body = await (await handleDiffRequest(req, url))!.json()
    expect(body.files).toEqual([{ path: "new.txt", status: "untracked", staged: false, patch: expect.any(String) }])
    expect(body.files[0].patch).toContain("+brand new")
  })

  it("shows both hunks when a tracked file has staged AND unstaged changes", async () => {
    fs.writeFileSync(path.join(dir, "tracked.txt"), "line one\nSTAGED\n")
    git("add", "tracked.txt")
    fs.writeFileSync(path.join(dir, "tracked.txt"), "line one\nUNSTAGED\n")
    const { req, url } = request()
    const body = await (await handleDiffRequest(req, url))!.json()
    expect(body.files).toHaveLength(1)
    expect(body.files[0].path).toBe("tracked.txt")
    expect(body.files[0].patch).toContain("STAGED")
    expect(body.files[0].patch).toContain("UNSTAGED")
  })

  it("sorts files alphabetically by path and covers a delete", async () => {
    fs.rmSync(path.join(dir, "tracked.txt"))
    fs.writeFileSync(path.join(dir, "a-new.txt"), "x\n")
    const { req, url } = request()
    const body = await (await handleDiffRequest(req, url))!.json()
    expect(body.files.map((f: { path: string }) => f.path)).toEqual(["a-new.txt", "tracked.txt"])
    expect(body.files[1].status).toBe("deleted")
  })
})
