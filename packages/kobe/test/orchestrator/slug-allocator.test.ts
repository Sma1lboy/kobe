import { describe, expect, it } from "vitest"
import { SlugAllocator } from "../../src/orchestrator/worktree/slug-allocator.ts"

// A repo path with no managed worktree roots on disk → listWorktreeDirNames
// returns [], so "occupied" reduces to active + pending slugs and the
// allocator's pure logic can be exercised without touching the filesystem.
const REPO = "/tmp/kobe-slug-test-does-not-exist"
// random:() => 0 makes `Math.floor(random() * n)` always pick index 0,
// so allocations are deterministic.
const FIRST = () => 0

describe("SlugAllocator", () => {
  it("picks a slug not held by an active task", async () => {
    const alloc = new SlugAllocator(() => ["panda"], { pool: ["panda", "tiger"], random: FIRST })
    expect(await alloc.allocate(REPO)).toBe("tiger")
  })

  it("does not hand out the same slug twice before commit", async () => {
    const alloc = new SlugAllocator(() => [], { pool: ["panda", "tiger"], random: FIRST })
    const a = await alloc.allocate(REPO)
    const b = await alloc.allocate(REPO)
    expect(a).toBe("panda")
    expect(b).toBe("tiger")
  })

  it("serializes concurrent allocations to distinct slugs", async () => {
    const alloc = new SlugAllocator(() => [], { pool: ["panda", "tiger", "otter"], random: FIRST })
    const slugs = await Promise.all([alloc.allocate(REPO), alloc.allocate(REPO), alloc.allocate(REPO)])
    expect(new Set(slugs).size).toBe(3)
  })

  it("version-suffixes when the pool is exhausted", async () => {
    const alloc = new SlugAllocator(() => [], { pool: ["panda"], random: FIRST })
    expect(await alloc.allocate(REPO)).toBe("panda")
    expect(await alloc.allocate(REPO)).toBe("panda-v2")
    expect(await alloc.allocate(REPO)).toBe("panda-v3")
  })

  it("commit and cancel both free the slug for reuse", async () => {
    const alloc = new SlugAllocator(() => [], { pool: ["panda"], random: FIRST })
    expect(await alloc.allocate(REPO)).toBe("panda")
    alloc.commit(REPO, "panda")
    expect(await alloc.allocate(REPO)).toBe("panda")
    alloc.cancel(REPO, "panda")
    expect(await alloc.allocate(REPO)).toBe("panda")
  })

  it("scopes pending slugs per repo so different repos can share a name", async () => {
    const alloc = new SlugAllocator(() => [], { pool: ["panda"], random: FIRST })
    expect(await alloc.allocate("/tmp/kobe-slug-repo-A-nope")).toBe("panda")
    expect(await alloc.allocate("/tmp/kobe-slug-repo-B-nope")).toBe("panda")
  })

  it("rejects an empty animal pool", () => {
    expect(() => new SlugAllocator(() => [], { pool: [] })).toThrow(/pool cannot be empty/)
  })
})
