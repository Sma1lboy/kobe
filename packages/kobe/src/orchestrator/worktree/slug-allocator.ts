import { ANIMAL_NAMES } from "./animal-names.ts"
import { listWorktreeDirNames } from "./paths.ts"

export type ActiveSlugSource = (repo: string) => readonly string[]

export interface SlugAllocatorOptions {
  readonly random?: () => number
  readonly pool?: readonly string[]
}

export class SlugAllocator {
  private readonly random: () => number
  private readonly pool: readonly string[]
  private readonly pendingByRepo = new Map<string, Set<string>>()
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

  async allocate(repo: string): Promise<string> {
    const previous = this.chain
    let release!: () => void
    this.chain = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await this.pickLocked(repo)
    } finally {
      release()
    }
  }

  commit(repo: string, slug: string): void {
    this.deletePending(repo, slug)
  }

  cancel(repo: string, slug: string): void {
    this.deletePending(repo, slug)
  }

  private async pickLocked(repo: string): Promise<string> {
    const occupied = await this.occupiedSlugs(repo)
    const candidates = this.pool.filter((n) => !occupied.has(n))
    if (candidates.length > 0) {
      const pick = candidates[Math.floor(this.random() * candidates.length)]!
      this.addPending(repo, pick)
      return pick
    }
    const base = this.pool[Math.floor(this.random() * this.pool.length)]!
    for (let v = 2; ; v++) {
      const candidate = `${base}-v${v}`
      if (!occupied.has(candidate)) {
        this.addPending(repo, candidate)
        return candidate
      }
    }
  }

  private async occupiedSlugs(repo: string): Promise<Set<string>> {
    const set = new Set<string>(this.pendingByRepo.get(repo) ?? [])
    for (const slug of this.activeSlugs(repo)) {
      if (slug) set.add(slug)
    }
    for (const dir of await listWorktreeDirNames(repo)) {
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
