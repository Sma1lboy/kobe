/**
 * Allocate animal-name slugs for worktree directories.
 *
 * Replaces the old "directory = task ULID" scheme (which produced 26-
 * char dir names that overflowed the terminal pane). The new shape is:
 *
 *   <repo>/.claude/worktrees/panda/
 *   <repo>/.claude/worktrees/panda-v2/   # if `panda` was recycled
 *
 * Mechanism (mirrors Conductor's city-name scheme, KOB-65):
 *   1. Build the "occupied" set: every slug currently held by a
 *      non-archived task in the store, PLUS every directory name
 *      already present on disk under `<repo>/.claude/worktrees/`,
 *      PLUS any slugs picked for the same repo by an earlier
 *      `allocate()` call that haven't yet been committed (race window
 *      between picking and persisting to the store).
 *   2. Filter {@link ANIMAL_NAMES} to candidates not in `occupied`.
 *   3. Pick one randomly. If the candidate set is empty (pool
 *      exhausted by ~410 simultaneous active worktrees in one repo —
 *      not realistic for kobe's use case), pick any base name and
 *      append `-v2`/`-v3`/... until one is free.
 *
 * Concurrency:
 *   - `allocate()` is async-serialized via a chain promise so two
 *     concurrent calls cannot pick the same slug. Inside the chain we
 *     refresh the occupied set on every iteration so the second caller
 *     sees the first caller's pick (via the per-repo pending set).
 *   - Callers commit / cancel the pick via {@link commit} /
 *     {@link cancel}. Commit clears the pending entry; cancel does
 *     the same (the difference is purely intent — both free the slot).
 *
 * Daemon mode: in-process serialization is enough because a single
 * daemon owns the task store. Two daemons against the same repo would
 * race, but that's already broken on the store's tasks.json writes.
 */

import { ANIMAL_NAMES } from "./animal-names.ts"
import { listWorktreeDirNames } from "./paths.ts"

/**
 * Source of "currently active slugs known to the application" — i.e.
 * the slugs the store reports as belonging to non-archived tasks.
 * Passed in rather than reaching for a TaskIndexStore so the allocator
 * stays testable without spinning up the full store.
 */
export type ActiveSlugSource = (repo: string) => readonly string[]

export interface SlugAllocatorOptions {
  /**
   * Override `Math.random` for deterministic tests. Defaults to
   * `Math.random`.
   */
  readonly random?: () => number
  /**
   * Override the bundled animal list. Tests use a tiny pool (e.g.
   * `["panda", "tiger"]`) to exercise the version-suffix fallback in
   * a single allocate cycle.
   */
  readonly pool?: readonly string[]
}

export class SlugAllocator {
  private readonly random: () => number
  private readonly pool: readonly string[]
  /**
   * Slugs picked but not yet committed, scoped by repo. Added on
   * allocate(), removed on commit/cancel. Treated as occupied for the
   * next allocate() in the same repo so a back-to-back race can't
   * return the same name twice, while different repos can still share
   * the same short slug.
   */
  private readonly pendingByRepo = new Map<string, Set<string>>()
  /** Serialise allocate() calls — see class-level concurrency note. */
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly activeSlugs: ActiveSlugSource,
    options: SlugAllocatorOptions = {},
  ) {
    this.random = options.random ?? Math.random
    this.pool = options.pool ?? ANIMAL_NAMES
    if (this.pool.length === 0) {
      throw new Error("SlugAllocator: animal pool cannot be empty")
    }
  }

  /**
   * Pick an unused slug for a new worktree in `repo`. The caller must
   * subsequently call {@link commit} (once the slug has been persisted
   * to the task store) or {@link cancel} (on error before persist).
   * Forgetting to commit/cancel leaks the slug — it stays in the
   * pending set for the lifetime of the process and is never picked
   * again. Not catastrophic (the pool is large) but worth being tidy
   * about.
   */
  async allocate(repo: string): Promise<string> {
    const previous = this.chain
    let release!: () => void
    this.chain = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return this.pickLocked(repo)
    } finally {
      release()
    }
  }

  /** Caller successfully persisted `slug`; release its pending slot. */
  commit(repo: string, slug: string): void {
    this.deletePending(repo, slug)
  }

  /**
   * Caller aborted before persisting (e.g. `git worktree add` failed).
   * Symmetric with commit; both free the slot so the next allocate can
   * reuse the name.
   */
  cancel(repo: string, slug: string): void {
    this.deletePending(repo, slug)
  }

  // --- internals ---

  private pickLocked(repo: string): string {
    const occupied = this.occupiedSlugs(repo)
    const candidates = this.pool.filter((n) => !occupied.has(n))
    if (candidates.length > 0) {
      const pick = candidates[Math.floor(this.random() * candidates.length)]!
      this.addPending(repo, pick)
      return pick
    }
    // Pool exhausted within this repo. Pick any base and version-suffix
    // it until we find a slot. The while-loop is bounded only by disk
    // free space; in practice we won't get past v2.
    const base = this.pool[Math.floor(this.random() * this.pool.length)]!
    for (let v = 2; ; v++) {
      const candidate = `${base}-v${v}`
      if (!occupied.has(candidate)) {
        this.addPending(repo, candidate)
        return candidate
      }
    }
  }

  private occupiedSlugs(repo: string): Set<string> {
    const set = new Set<string>(this.pendingByRepo.get(repo) ?? [])
    for (const slug of this.activeSlugs(repo)) {
      if (slug) set.add(slug)
    }
    for (const dir of listWorktreeDirNames(repo)) {
      set.add(dir)
    }
    return set
  }

  private addPending(repo: string, slug: string): void {
    let pending = this.pendingByRepo.get(repo)
    if (!pending) {
      pending = new Set<string>()
      this.pendingByRepo.set(repo, pending)
    }
    pending.add(slug)
  }

  private deletePending(repo: string, slug: string): void {
    const pending = this.pendingByRepo.get(repo)
    if (!pending) return
    pending.delete(slug)
    if (pending.size === 0) this.pendingByRepo.delete(repo)
  }
}
