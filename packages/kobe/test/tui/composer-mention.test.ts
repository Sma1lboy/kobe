/**
 * Unit tests for the `@`-mention helpers (`src/tui/chat/composer/mention.ts`).
 *
 * Two halves:
 *   - Pure logic: `findMentionContext` (anchor walk-back + word-boundary
 *     guard), `formatDisplayPath` (`packages/` strip), `filterMentionMatches`
 *     (filename-prefix > dir-boundary > contains ranking, length tie-break).
 *   - `getWorktreeFiles` / `invalidateWorktreeFiles`: the 30s file-list cache.
 *     `listFiles` (the only I/O seam) is mocked so no git spawns.
 */

import { beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("../../src/tui/panes/filetree/git", () => ({
  listFiles: vi.fn(),
}))

import {
  filterMentionMatches,
  findMentionContext,
  formatDisplayPath,
  getWorktreeFiles,
  invalidateWorktreeFiles,
} from "../../src/tui/chat/composer/mention"
import { listFiles } from "../../src/tui/panes/filetree/git"

const mockListFiles = vi.mocked(listFiles)

describe("findMentionContext", () => {
  test("returns the anchor and live query for `@que` at the cursor", () => {
    expect(findMentionContext("ping @que", 9)).toEqual({ atPos: 5, query: "que" })
  })

  test("empty query right after a bare `@`", () => {
    expect(findMentionContext("hi @", 4)).toEqual({ atPos: 3, query: "" })
  })

  test("`@` at buffer start is a valid anchor", () => {
    expect(findMentionContext("@foo", 4)).toEqual({ atPos: 0, query: "foo" })
  })

  test("mid-word `@` (email) does NOT trigger a mention", () => {
    expect(findMentionContext("mail me@host", 12)).toBeNull()
  })

  test("whitespace between cursor and the nearest `@` cancels the mention", () => {
    expect(findMentionContext("@foo bar", 8)).toBeNull()
  })

  test("out-of-range cursor → null", () => {
    expect(findMentionContext("@foo", 0)).toBeNull()
    expect(findMentionContext("@foo", 99)).toBeNull()
  })
})

describe("formatDisplayPath", () => {
  test("strips a leading `packages/` segment", () => {
    expect(formatDisplayPath("packages/kobe/src/App.tsx")).toBe("kobe/src/App.tsx")
  })

  test("identity on non-monorepo paths", () => {
    expect(formatDisplayPath("src/App.tsx")).toBe("src/App.tsx")
  })
})

describe("filterMentionMatches", () => {
  const files = ["src/index.ts", "src/composer/Composer.tsx", "packages/kobe/README.md", "test/index.test.ts"]

  test("empty query returns the first `limit` files verbatim", () => {
    const out = filterMentionMatches(files, "", 2)
    expect(out.map((m) => m.path)).toEqual(["src/index.ts", "src/composer/Composer.tsx"])
    expect(out[0]?.score).toBe(0)
  })

  test("filename-prefix match outranks a substring match", () => {
    const out = filterMentionMatches(files, "index", 10)
    // `index.ts` and `index.test.ts` both start their filename with `index`.
    expect(out[0]?.path).toBe("src/index.ts")
    expect(out.some((m) => m.path === "src/composer/Composer.tsx")).toBe(false)
  })

  test("case-insensitive, literal substring (not regex)", () => {
    const out = filterMentionMatches(files, "COMPOSER", 10)
    expect(out.map((m) => m.path)).toContain("src/composer/Composer.tsx")
  })

  test("shorter path wins the tie within the same score tier", () => {
    const tie = ["a/thing.ts", "deeply/nested/dir/thing.ts"]
    const out = filterMentionMatches(tie, "thing", 10)
    expect(out[0]?.path).toBe("a/thing.ts")
  })

  test("no matches, empty file list, or non-positive limit → []", () => {
    expect(filterMentionMatches(files, "zzzz", 10)).toEqual([])
    expect(filterMentionMatches([], "index", 10)).toEqual([])
    expect(filterMentionMatches(files, "index", 0)).toEqual([])
  })

  test("carries the display path through", () => {
    const out = filterMentionMatches(["packages/kobe/README.md"], "readme", 10)
    expect(out[0]?.displayPath).toBe("kobe/README.md")
  })
})

describe("getWorktreeFiles cache", () => {
  beforeEach(() => {
    mockListFiles.mockReset()
    invalidateWorktreeFiles("/wt/a")
    invalidateWorktreeFiles("/wt/b")
  })

  test("spawns once, then serves the cached list on the next call", async () => {
    mockListFiles.mockResolvedValue(["x.ts"])
    expect(await getWorktreeFiles("/wt/a")).toEqual(["x.ts"])
    expect(await getWorktreeFiles("/wt/a")).toEqual(["x.ts"])
    expect(mockListFiles).toHaveBeenCalledTimes(1)
  })

  test("invalidate forces a fresh spawn on the next open", async () => {
    mockListFiles.mockResolvedValue(["x.ts"])
    await getWorktreeFiles("/wt/a")
    invalidateWorktreeFiles("/wt/a")
    await getWorktreeFiles("/wt/a")
    expect(mockListFiles).toHaveBeenCalledTimes(2)
  })

  test("a listFiles failure collapses to an empty list (dropdown still opens)", async () => {
    mockListFiles.mockRejectedValue(new Error("not a worktree"))
    expect(await getWorktreeFiles("/wt/b")).toEqual([])
  })
})
