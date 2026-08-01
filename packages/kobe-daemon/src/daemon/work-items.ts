/**
 * External work items — a READ-ONLY view of issues that live in someone else's
 * tracker, so you can start work on one without leaving kobe.
 *
 * Deliberately not an import: a GitHub issue stays GitHub's. kobe never copies
 * it into the local issue store, never writes state back, and never tries to
 * keep two lifecycles in sync — the local store owns kobe's own backlog
 * (docs/WORK-TRACKING.md), and this is a different thing sitting beside it.
 * The only durable trace a work item leaves is the `linkedWorkItem` stamped on
 * the task started from it.
 *
 * GitHub only, through the `gh` CLI the daemon already shells out to for PR
 * status. That means zero new dependencies and zero new auth: if `gh` works in
 * your terminal, this works. Adding a second provider is a real project (auth,
 * pagination, a field model per tracker) and is not pre-built here.
 */

import { spawn } from "node:child_process"

/** Vendor-neutral shape the CLI and any future UI render. */
export interface WorkItem {
  readonly provider: "github"
  readonly type: "issue" | "pr"
  readonly number: number
  readonly title: string
  readonly state: string
  readonly url: string
  readonly updatedAt: string
  readonly author?: string
  readonly labels: readonly string[]
  /** Present only on a single-item fetch; the list view omits it. */
  readonly body?: string
}

/** How long a fetched list stays fresh. Short: this is a browse surface, and
 *  `gh` is a network round trip a user is waiting on. */
export const WORK_ITEMS_TTL_MS = 60_000

/** Upper bound on one fetch. `gh` paginates above this; a browse list that
 *  needs more than 50 rows wants a search query, not a bigger page. */
export const WORK_ITEMS_MAX_LIMIT = 50

const GH_TIMEOUT_MS = 20_000

const LIST_FIELDS = "number,title,state,updatedAt,labels,author,url"
const ITEM_FIELDS = `${LIST_FIELDS},body`

export interface WorkItemQuery {
  /** Repo directory the `gh` call runs in — it resolves the remote itself. */
  readonly cwd: string
  readonly state?: "open" | "closed" | "all"
  readonly limit?: number
  /** Free-text search passed to `gh --search`. */
  readonly search?: string
  /** Restrict to items assigned to a user (`@me` for yourself). */
  readonly assignee?: string
  readonly labels?: readonly string[]
}

export class WorkItemError extends Error {
  constructor(
    message: string,
    readonly kind: "gh-missing" | "auth" | "no-remote" | "failed",
  ) {
    super(message)
    this.name = "WorkItemError"
  }
}

interface GhResult {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly spawnError: boolean
}

/** Chunks are joined as BYTES before decoding: a stdout pipe splits on an
 *  arbitrary boundary, so a multi-byte UTF-8 sequence in a non-ASCII issue
 *  title can straddle two chunks and decode to `�` if handled per-chunk.
 *  Same reasoning as `pr-status-collector.ts`'s `decodeSpawnChunks`. */
function decodeChunks(chunks: readonly (Buffer | string)[]): string {
  return Buffer.concat(chunks.map((c) => (typeof c === "string" ? Buffer.from(c) : c))).toString("utf8")
}

/** Never rejects — a spawn failure resolves as `spawnError` so the caller
 *  classifies it alongside a non-zero exit. */
function runGh(args: readonly string[], cwd: string): Promise<GhResult> {
  return new Promise((resolve) => {
    const out: (Buffer | string)[] = []
    const err: (Buffer | string)[] = []
    let settled = false
    const controller = new AbortController()
    const finish = (status: number | null, spawnError: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status, stdout: decodeChunks(out), stderr: decodeChunks(err), spawnError })
    }
    const timer = setTimeout(() => {
      controller.abort()
      finish(null, false)
    }, GH_TIMEOUT_MS)
    timer.unref?.()

    const child = spawn("gh", args.slice(), {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: controller.signal,
      killSignal: "SIGKILL",
    })
    child.stdout?.on("data", (c: Buffer | string) => out.push(c))
    child.stderr?.on("data", (c: Buffer | string) => err.push(c))
    child.on("error", () => finish(null, !controller.signal.aborted))
    child.on("close", (code) => finish(code, false))
  })
}

/**
 * Turn a failed `gh` run into an error a human can act on. The distinction
 * that matters: "install gh" / "run gh auth login" / "this repo has no GitHub
 * remote" are three different fixes, and a generic "command failed" sends the
 * user hunting through all three.
 */
export function classifyGhFailure(result: GhResult): WorkItemError {
  if (result.spawnError) {
    return new WorkItemError("the `gh` CLI is not installed or not on PATH", "gh-missing")
  }
  const stderr = result.stderr.toLowerCase()
  if (stderr.includes("not logged") || stderr.includes("authentication") || stderr.includes("gh auth login")) {
    return new WorkItemError("`gh` is not authenticated — run `gh auth login`", "auth")
  }
  if (stderr.includes("no git remote") || stderr.includes("could not determine") || stderr.includes("not a git repo")) {
    return new WorkItemError("no GitHub remote found for this repo", "no-remote")
  }
  const detail = result.stderr.trim() || `gh exited ${result.status}`
  return new WorkItemError(detail, "failed")
}

interface GhIssueJson {
  number?: unknown
  title?: unknown
  state?: unknown
  url?: unknown
  updatedAt?: unknown
  body?: unknown
  author?: { login?: unknown } | null
  labels?: Array<{ name?: unknown }> | null
}

/** Defensive: `gh`'s JSON shape is stable but not a contract we control. */
function normalizeItem(raw: GhIssueJson, type: WorkItem["type"]): WorkItem | null {
  if (typeof raw.number !== "number" || typeof raw.title !== "string") return null
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((l) => (typeof l?.name === "string" ? l.name : null)).filter((n): n is string => n !== null)
    : []
  return {
    provider: "github",
    type,
    number: raw.number,
    title: raw.title,
    state: typeof raw.state === "string" ? raw.state.toLowerCase() : "unknown",
    url: typeof raw.url === "string" ? raw.url : "",
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
    ...(typeof raw.author?.login === "string" ? { author: raw.author.login } : {}),
    labels,
    ...(typeof raw.body === "string" && raw.body.length > 0 ? { body: raw.body } : {}),
  }
}

function buildListArgs(query: WorkItemQuery): string[] {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), WORK_ITEMS_MAX_LIMIT)
  const args = ["issue", "list", "--json", LIST_FIELDS, "--limit", String(limit), "--state", query.state ?? "open"]
  if (query.search) args.push("--search", query.search)
  if (query.assignee) args.push("--assignee", query.assignee)
  for (const label of query.labels ?? []) args.push("--label", label)
  return args
}

/** Fetch issues for the repo at `query.cwd`. Throws {@link WorkItemError}. */
export async function fetchWorkItems(query: WorkItemQuery): Promise<WorkItem[]> {
  const result = await runGh(buildListArgs(query), query.cwd)
  if (result.status !== 0) throw classifyGhFailure(result)
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new WorkItemError("could not parse the `gh` response", "failed")
  }
  if (!Array.isArray(parsed)) throw new WorkItemError("unexpected `gh` response shape", "failed")
  return parsed
    .map((raw) => normalizeItem(raw as GhIssueJson, "issue"))
    .filter((item): item is WorkItem => item !== null)
}

/** Fetch ONE issue including its body — what a start-work prompt needs. */
export async function fetchWorkItem(cwd: string, number: number): Promise<WorkItem> {
  const result = await runGh(["issue", "view", String(number), "--json", ITEM_FIELDS], cwd)
  if (result.status !== 0) throw classifyGhFailure(result)
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new WorkItemError("could not parse the `gh` response", "failed")
  }
  const item = normalizeItem(parsed as GhIssueJson, "issue")
  if (!item) throw new WorkItemError(`issue #${number} could not be read`, "failed")
  return item
}

/** Cache key: every field that changes the result set. */
function queryKey(query: WorkItemQuery): string {
  return [
    query.cwd,
    query.state ?? "open",
    query.limit ?? 20,
    query.search ?? "",
    query.assignee ?? "",
    [...(query.labels ?? [])].sort().join(","),
  ].join(" ")
}

/**
 * Short-TTL memory cache in front of {@link fetchWorkItems}. In memory only —
 * this is a view of someone else's data, and a stale copy surviving a daemon
 * restart would be worse than refetching.
 */
export class WorkItemCache {
  private readonly entries = new Map<string, { at: number; items: WorkItem[] }>()

  constructor(
    private readonly ttlMs = WORK_ITEMS_TTL_MS,
    private readonly now = () => Date.now(),
    private readonly fetch = fetchWorkItems,
  ) {}

  async list(query: WorkItemQuery, force = false): Promise<WorkItem[]> {
    const key = queryKey(query)
    const hit = this.entries.get(key)
    if (!force && hit && this.now() - hit.at <= this.ttlMs) return hit.items
    const items = await this.fetch(query)
    this.entries.set(key, { at: this.now(), items })
    return items
  }

  clear(): void {
    this.entries.clear()
  }
}
