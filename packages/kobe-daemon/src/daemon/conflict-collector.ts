/**
 * Daemon-side conflict radar collector (docs/design/conflict-radar.md).
 *
 * Two-tier signal over the in-flight worktree tasks of each repo:
 *
 *   - L1 `overlap` — the cards' touched-file sets intersect. Per card ONE
 *     cheap footprint (HEAD + dirty paths + committed paths vs the repo's
 *     default ref); the pairwise part is pure in-memory set intersection,
 *     so the O(N²) lands on the free operation.
 *   - L2 `conflict` — for L1 pairs only, a `git merge-tree --write-tree`
 *     DRY-RUN of the two heads (never touches any worktree). Cached by the
 *     head pair, so it reruns only when someone commits.
 *
 * Non-blocking discipline (the whole point — these run beside the agents'
 * own git activity, often in BULK):
 *   - every git call is an async spawn through {@link spawnCapture} — the
 *     daemon's event loop never blocks;
 *   - `GIT_OPTIONAL_LOCKS=0` on every read, so the radar never takes
 *     `.git/index.lock` from under an engine's own commit;
 *   - a global {@link GitGate} caps concurrent git children across ALL
 *     cards and merge-tree probes — a 30-card board queues, never stampedes;
 *   - per-card scheduling rides `@/lib/poll-scheduling` (in-flight dedupe,
 *     timeout + SIGKILL, hard backoff, adaptive cadence) — the exact guards
 *     that fixed the 30GB-repo freeze for worktree-changes;
 *   - footprints republish on change only, and the consumer gate skips the
 *     whole pass while nobody is subscribed.
 *
 * `git merge-tree --write-tree` needs git ≥ 2.38; an unsupported git is
 * detected once and the radar degrades to L1-only (log, not error).
 */

import {
  type PollCadenceConfig,
  type PollScheduleState,
  maybeStartScheduledRun,
  spawnCapture,
} from "@/lib/poll-scheduling"
import { isRemoteRepoKey } from "@/state/repos"
import type { Task } from "@/types/task"
import { logDaemonError } from "./crash-log.ts"
import type { DaemonEventBus } from "./event-bus.ts"
import type { ConflictPair, ConflictsPayload } from "./protocol.ts"
import type { TaskLister } from "./worktree-changes-collector.ts"

/** Conflicts move slower than dirty counts — a relaxed tick is plenty. */
export const DEFAULT_CONFLICTS_TICK_MS = 5_000
export const CONFLICTS_TIMEOUT_MS = 5_000
export const CONFLICTS_SLOW_RETRY_MS = 60_000
export const CONFLICTS_MIN_INTERVAL_MS = 10_000
/** Ceiling on concurrent git children across the whole radar. */
const MAX_CONCURRENT_GIT = 3
/** merge-tree gets its own (generous) leash — it's rarer and heavier. */
const MERGE_TREE_TIMEOUT_MS = 8_000

/** Tiny FIFO semaphore — bounds the radar's git process fan-out. */
export class GitGate {
  private active = 0
  private readonly waiters: Array<() => void> = []
  constructor(private readonly limit: number = MAX_CONCURRENT_GIT) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
    this.active += 1
    try {
      return await fn()
    } finally {
      this.active -= 1
      this.waiters.shift()?.()
    }
  }
}

/** One card's git footprint: where its head is and which files it touches. */
export interface CardFootprint {
  readonly repo: string
  readonly head: string
  readonly files: ReadonlySet<string>
}

const LOCK_FREE_ENV = { GIT_OPTIONAL_LOCKS: "0" }

async function git(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  gate: GitGate,
): Promise<{ status: number | null; stdout: string }> {
  return gate.run(() => spawnCapture("git", args, { cwd, env: { ...process.env, ...LOCK_FREE_ENV }, signal }))
}

/** Dirty paths from porcelain v1 — both sides of a rename count. */
export function parsePorcelainPaths(stdout: string): string[] {
  const paths: string[] = []
  for (const line of stdout.split("\n")) {
    if (line.length < 4) continue
    const rest = line.slice(3)
    const arrow = rest.indexOf(" -> ")
    if (arrow >= 0) {
      paths.push(rest.slice(0, arrow), rest.slice(arrow + 4))
    } else {
      paths.push(rest)
    }
  }
  return paths
}

/** Candidate base refs, in resolution order, for "what this branch adds". */
const BASE_REF_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"]

/** Resolve the repo's default ref name (first verifiable candidate). */
export async function resolveBaseRef(worktree: string, signal: AbortSignal, gate: GitGate): Promise<string | null> {
  for (const ref of BASE_REF_CANDIDATES) {
    const res = await git(worktree, ["rev-parse", "--verify", "--quiet", ref], signal, gate)
    if (res.status === 0) return ref
  }
  return null
}

/**
 * One card's footprint: HEAD sha, plus dirty paths ∪ committed paths
 * relative to the merge-base with `baseRef` (three-dot diff — one call,
 * no explicit merge-base step). `baseRef === null` → dirty paths only.
 */
export async function collectFootprint(
  worktree: string,
  repo: string,
  baseRef: string | null,
  signal: AbortSignal,
  gate: GitGate,
): Promise<CardFootprint> {
  const head = await git(worktree, ["rev-parse", "HEAD"], signal, gate)
  if (head.status !== 0) throw new Error("rev-parse HEAD failed")
  const files = new Set<string>()
  const status = await git(worktree, ["status", "--porcelain=v1"], signal, gate)
  if (status.status !== 0) throw new Error("git status failed")
  for (const p of parsePorcelainPaths(status.stdout)) files.add(p)
  if (baseRef) {
    const diff = await git(worktree, ["diff", "--name-only", `${baseRef}...HEAD`], signal, gate)
    // A branch with no merge-base (exotic adopt) just contributes dirty
    // paths — L1-only for that card, never an error.
    if (diff.status === 0) {
      for (const p of diff.stdout.split("\n")) if (p) files.add(p)
    }
  }
  return { repo, head: head.stdout.trim(), files }
}

export function sameFootprint(a: CardFootprint, b: CardFootprint): boolean {
  if (a.head !== b.head || a.files.size !== b.files.size) return false
  for (const f of a.files) if (!b.files.has(f)) return false
  return true
}

/** The radar's population: in-flight worktree tasks on this machine. */
export function trackedConflictTasks(tasks: readonly Task[]): Task[] {
  return tasks.filter(
    (t) =>
      !t.archived &&
      (t.kind ?? "task") !== "main" &&
      !!t.worktreePath &&
      !isRemoteRepoKey(t.repo) &&
      !isRemoteRepoKey(t.worktreePath),
  )
}

/** L1: same-repo pairs whose file sets intersect. Pure; ids sorted. */
export function overlapPairs(cards: ReadonlyMap<string, CardFootprint>): ConflictPair[] {
  const ids = [...cards.keys()].sort()
  const pairs: ConflictPair[] = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = cards.get(ids[i] as string) as CardFootprint
      const b = cards.get(ids[j] as string) as CardFootprint
      if (a.repo !== b.repo) continue
      const files = [...a.files].filter((f) => b.files.has(f)).sort()
      if (files.length === 0) continue
      pairs.push({ a: ids[i] as string, b: ids[j] as string, files, level: "overlap" })
    }
  }
  return pairs
}

/** Conflicted filenames from `merge-tree --write-tree --name-only` output:
 *  line 0 is the tree OID, then conflicted names until the blank line. */
export function parseMergeTreeNames(stdout: string): string[] {
  const lines = stdout.split("\n")
  const names: string[] = []
  for (const line of lines.slice(1)) {
    if (!line) break
    names.push(line)
  }
  return names
}

export function samePairs(a: readonly ConflictPair[], b: readonly ConflictPair[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

interface CardEntry extends PollScheduleState {
  value?: CardFootprint
}

type MergeProbe = { state: "pending" } | { state: "clean" } | { state: "conflict"; files: readonly string[] }

export interface ConflictCollectorOptions {
  readonly cadence?: PollCadenceConfig
  /** Injectable footprint runner — tests avoid real git/worktrees. */
  readonly footprint?: (task: Task, signal: AbortSignal) => Promise<CardFootprint>
  /** Injectable merge-tree prober. Resolve `null` for "unsupported". */
  readonly probeMerge?: (
    worktree: string,
    headA: string,
    headB: string,
  ) => Promise<{ conflict: boolean; files: string[] } | null>
  readonly hasSubscribers?: () => boolean
}

/**
 * Tick-driven, same contract as {@link WorktreeChangesCollector}: `tick()`
 * never throws, prunes dropped tasks, schedules guarded footprint runs,
 * recomputes pairs in memory as results land, and publishes the full pair
 * list on change only.
 */
export class ConflictCollector {
  private readonly entries = new Map<string, CardEntry>()
  private readonly baseRefs = new Map<string, Promise<string | null>>()
  private readonly mergeProbes = new Map<string, MergeProbe>()
  private readonly gate = new GitGate()
  private mergeTreeUnsupported = false
  // Seeded empty so a no-conflict recompute on boot publishes nothing —
  // every consumer already defaults to "no pairs".
  private lastPublished: ConflictPair[] = []
  private stopped = false

  constructor(
    private readonly orch: TaskLister,
    private readonly bus: DaemonEventBus,
    private readonly options: ConflictCollectorOptions = {},
  ) {}

  tick(): void {
    if (this.stopped) return
    if (this.options.hasSubscribers && !this.options.hasSubscribers()) return
    try {
      const tracked = trackedConflictTasks(this.orch.listTasks())
      const trackedIds = new Set(tracked.map((t) => t.id as string))
      let pruned = false
      for (const id of this.entries.keys()) {
        if (trackedIds.has(id)) continue
        if (this.entries.get(id)?.value) pruned = true
        this.entries.delete(id)
      }
      if (pruned) this.recompute()
      for (const task of tracked) this.maybeCollect(task)
    } catch (err) {
      logDaemonError("conflict-radar", err)
    }
  }

  stop(): void {
    this.stopped = true
  }

  private maybeCollect(task: Task): void {
    const id = task.id as string
    let entry = this.entries.get(id)
    if (!entry) {
      entry = { inFlight: false, nextAllowedAt: 0 }
      this.entries.set(id, entry)
    }
    const cadence = this.options.cadence ?? {
      timeoutMs: CONFLICTS_TIMEOUT_MS,
      slowRetryMs: CONFLICTS_SLOW_RETRY_MS,
      minIntervalMs: CONFLICTS_MIN_INTERVAL_MS,
    }
    const run =
      this.options.footprint ??
      (async (t: Task, signal: AbortSignal) => {
        const baseRef = await this.baseRefFor(t.worktreePath, signal)
        return collectFootprint(t.worktreePath, t.repo, baseRef, signal, this.gate)
      })
    maybeStartScheduledRun(
      entry,
      cadence,
      (signal) => run(task, signal),
      (value) => {
        if (this.stopped) return
        if (this.entries.get(id) !== entry) return
        if (entry.value && sameFootprint(entry.value, value)) return
        entry.value = value
        this.recompute()
      },
    )
  }

  /** Default-ref name per repo, resolved once (promise-cached). */
  private baseRefFor(worktree: string, signal: AbortSignal): Promise<string | null> {
    const cached = this.baseRefs.get(worktree)
    if (cached) return cached
    const promise = resolveBaseRef(worktree, signal, this.gate).catch(() => null)
    this.baseRefs.set(worktree, promise)
    return promise
  }

  /** Rebuild the pair list from current footprints; schedule L2 probes for
   *  overlap pairs whose head-pair hasn't been judged yet. */
  private recompute(): void {
    const cards = new Map<string, CardFootprint>()
    for (const [id, entry] of this.entries) {
      if (entry.value) cards.set(id, entry.value)
    }
    const pairs = overlapPairs(cards)
    const resolved: ConflictPair[] = []
    for (const pair of pairs) {
      const a = cards.get(pair.a) as CardFootprint
      const b = cards.get(pair.b) as CardFootprint
      const key = [a.repo, ...[a.head, b.head].sort()].join("\0")
      const probe = this.mergeProbes.get(key)
      if (probe?.state === "conflict") {
        resolved.push({
          ...pair,
          level: "conflict",
          // merge-tree's conflicted names are the precise set; fall back to
          // the overlap files when the parse came up empty.
          files: probe.files.length > 0 ? probe.files : pair.files,
        })
        continue
      }
      resolved.push(pair)
      if (!probe && !this.mergeTreeUnsupported && a.head !== b.head) {
        this.scheduleMergeProbe(key, cards, pair)
      }
    }
    if (samePairs(this.lastPublished, resolved)) return
    this.lastPublished = resolved
    const payload: ConflictsPayload = { pairs: resolved }
    this.bus.publish("task.conflicts", payload)
  }

  private scheduleMergeProbe(key: string, cards: ReadonlyMap<string, CardFootprint>, pair: ConflictPair): void {
    const a = cards.get(pair.a) as CardFootprint
    const b = cards.get(pair.b) as CardFootprint
    this.mergeProbes.set(key, { state: "pending" })
    // Any worktree of the repo sees the shared object store; use a's.
    const worktree = this.worktreeOf(pair.a)
    const probe =
      this.options.probeMerge ??
      (async (wt: string, headA: string, headB: string) => {
        const res = await git(
          wt,
          ["merge-tree", "--write-tree", "--name-only", headA, headB],
          AbortSignal.timeout(MERGE_TREE_TIMEOUT_MS),
          this.gate,
        )
        if (res.status === 0) return { conflict: false, files: [] }
        if (res.status === 1) return { conflict: true, files: parseMergeTreeNames(res.stdout) }
        return null // unsupported git / no merge base — degrade to L1
      })
    if (!worktree) {
      this.mergeProbes.delete(key)
      return
    }
    void probe(worktree, a.head, b.head)
      .then((result) => {
        if (this.stopped) return
        if (result === null) {
          if (!this.mergeTreeUnsupported) {
            this.mergeTreeUnsupported = true
            console.log(
              "[conflict-radar] merge-tree dry-run unavailable (git < 2.38 or no merge base) — radar degrades to file-overlap only",
            )
          }
          this.mergeProbes.delete(key)
          return
        }
        this.mergeProbes.set(key, result.conflict ? { state: "conflict", files: result.files } : { state: "clean" })
        this.recompute()
      })
      .catch((err) => {
        this.mergeProbes.delete(key)
        logDaemonError("conflict-radar", err)
      })
  }

  private worktreeOf(taskId: string): string | undefined {
    const task = this.orch.listTasks().find((t) => t.id === taskId)
    return task?.worktreePath || undefined
  }
}

/** Production interval binding — same conventions as the other collectors:
 *  `tickMs <= 0` disables, `hasSubscribers` is the idle-daemon gate. */
export function startConflictCollector(
  orch: TaskLister,
  bus: DaemonEventBus,
  tickMs: number = DEFAULT_CONFLICTS_TICK_MS,
  hasSubscribers?: () => boolean,
): () => void {
  if (tickMs <= 0) return () => {}
  const collector = new ConflictCollector(orch, bus, { hasSubscribers })
  collector.tick()
  const timer = setInterval(() => collector.tick(), tickMs)
  timer.unref?.()
  return () => {
    clearInterval(timer)
    collector.stop()
  }
}
