import { describe, expect, it } from "vitest"
import { mapPool, splitDiffByFile, statusLabel } from "../../src/web/diff.ts"

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
    // Git leaves spaces unquoted (only control chars / quotes trigger C-quoting),
    // so the `+++ b/<path>` marker carries the literal space.
    const diff = [
      "diff --git a/has space.ts b/has space.ts",
      "index 111..222 100644",
      "--- a/has space.ts",
      "+++ b/has space.ts",
      "@@ -1 +1 @@",
      "-x",
      "+y",
      "",
    ].join("\n")
    const byFile = splitDiffByFile(diff)
    expect(byFile.has("has space.ts")).toBe(true)
    expect(byFile.get("has space.ts")).toContain("+y")
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
