import { execFile } from "node:child_process"
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type IssueStatus = "open" | "doing" | "hold" | "done"

export const ISSUE_STATUSES: readonly IssueStatus[] = ["open", "doing", "hold", "done"]

export interface Issue {
  id: number
  title: string
  status: IssueStatus
  created: string
  body: string
  /** Linked task ULID — set when a task is spawned from this issue (link op). */
  taskId?: string
}

export interface RepoIssues {
  repoRoot: string
  exists: boolean
  nextId: number
  issues: Issue[]
}

interface RepoIssueRecord {
  repoRoot: string
  nextId: number
  issues: Issue[]
}

interface IssuesStoreFile {
  version: 1
  repos: Record<string, RepoIssueRecord>
}

type IssueOp =
  | { type: "create"; title?: unknown; body?: unknown }
  | { type: "setStatus"; id?: unknown; status?: unknown }
  | { type: "update"; id?: unknown; title?: unknown; body?: unknown }
  | { type: "link"; id?: unknown; taskId?: unknown }
  | { type: "unlink"; id?: unknown }
  | { type: "delete"; id?: unknown }

function isGitNotRepositoryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes("not a git repository")
}

export function defaultIssuesStorePath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "issues.json")
}

function isValidStatus(value: unknown): value is IssueStatus {
  return typeof value === "string" && (ISSUE_STATUSES as readonly string[]).includes(value)
}

function normalizeIssue(entry: unknown): Issue | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null
  const raw = entry as Record<string, unknown>
  if (typeof raw.id !== "number") return null
  return {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "(untitled)",
    status: isValidStatus(raw.status) ? raw.status : "open",
    created: typeof raw.created === "string" ? raw.created : "",
    body: typeof raw.body === "string" ? raw.body : "",
    taskId: typeof raw.taskId === "string" ? raw.taskId : undefined,
  }
}

function emptyStore(): IssuesStoreFile {
  return { version: 1, repos: {} }
}

function todayStamp(): string {
  // KOBE_ISSUES_TODAY pins the stamp for visual-fixture determinism: the
  // Kanban screenshot gate renders `created` on every card, so a real clock
  // shifts the snapshot at each midnight. Never set in production.
  const pinned = process.env.KOBE_ISSUES_TODAY
  if (pinned && /^\d{4}-\d{2}-\d{2}$/.test(pinned)) return pinned
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, "0")
  const dd = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${mm}-${dd}`
}

async function gitCommonDir(path: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--git-common-dir"])
  const dir = stdout.trim()
  return realpath(isAbsolute(dir) ? dir : resolve(path, dir))
}

async function gitTopLevel(path: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--show-toplevel"])
  return stdout.trim()
}

async function gitMainWorktree(path: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", path, "worktree", "list", "--porcelain"])
  const first = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length)
    .trim()
  return first ? realpath(first) : gitTopLevel(path)
}

async function resolveRepo(raw: unknown): Promise<{ repoRoot: string; repoKey: string }> {
  if (typeof raw !== "string" || raw.length === 0) throw new Error("repoRoot is required")
  const absolute = resolve(raw)
  const s = await stat(absolute).catch(() => null)
  if (!s?.isDirectory()) throw new Error("repoRoot does not exist")
  try {
    const [repoRoot, repoKey] = await Promise.all([gitMainWorktree(absolute), gitCommonDir(absolute)])
    return { repoRoot, repoKey }
  } catch (err) {
    if (isGitNotRepositoryError(err)) throw new Error("repoRoot is not a git repository")
    throw err
  }
}

async function readStore(path: string): Promise<IssuesStoreFile> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<IssuesStoreFile>
    const repos: Record<string, RepoIssueRecord> = {}
    if (raw.repos && typeof raw.repos === "object") {
      for (const [key, value] of Object.entries(raw.repos)) {
        if (!value || typeof value !== "object") continue
        const record = value as Partial<RepoIssueRecord>
        repos[key] = {
          repoRoot: typeof record.repoRoot === "string" ? record.repoRoot : "",
          nextId: typeof record.nextId === "number" ? record.nextId : 1,
          issues: Array.isArray(record.issues)
            ? record.issues.map(normalizeIssue).filter((issue): issue is Issue => issue !== null)
            : [],
        }
      }
    }
    return { version: 1, repos }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore()
    throw err
  }
}

async function writeStore(path: string, store: IssuesStoreFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8")
  await rename(tmp, path)
}

function response(repoRoot: string, record: RepoIssueRecord | null): RepoIssues {
  return {
    repoRoot,
    exists: record !== null,
    nextId: record?.nextId ?? 1,
    issues: record?.issues ?? [],
  }
}

const locks = new Map<string, Promise<unknown>>()

/**
 * Serialize async sections that share a resource named by `key`. The issue
 * store keeps ALL repos in one file (read/written whole), so the unit of
 * contention is the file path, NOT the repoKey — locking per-repo lets two
 * different repos' read-modify-write cycles interleave and the second
 * `writeStore` rename silently drops the first repo's mutation. Callers pass
 * `this.path` so every mutation against the file is serialized.
 */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const tail = locks.get(key) ?? Promise.resolve()
  const run = tail.then(fn)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  locks.set(key, settled)
  void settled.then(() => {
    if (locks.get(key) === settled) locks.delete(key)
  })
  return run
}

export class IssuesStore {
  constructor(private readonly path = defaultIssuesStorePath()) {}

  async list(repo: unknown): Promise<RepoIssues> {
    const { repoRoot, repoKey } = await resolveRepo(repo)
    return withLock(this.path, async () => {
      const store = await readStore(this.path)
      const record = store.repos[repoKey] ?? null
      if (record && record.repoRoot !== repoRoot) {
        record.repoRoot = repoRoot
        await writeStore(this.path, store)
      }
      return response(repoRoot, record)
    })
  }

  /**
   * Mirror a task→done transition onto its linked issue, atomically. The link
   * is owned by the issue (`Issue.taskId`), so we reverse-look-up the issue
   * whose `taskId` is this task and flip it to `done` — all inside ONE lock, so
   * a concurrent reopen (another surface flipping the same issue back to
   * open/doing between a separate read and write) can't be clobbered by a stale
   * decision. Returns the updated state when a not-already-done linked issue was
   * found and flipped, else `null` (nothing to mirror — no record, no linked
   * issue, or it's already done).
   */
  async mirrorTaskDone(repo: unknown, taskId: string): Promise<RepoIssues | null> {
    const { repoRoot, repoKey } = await resolveRepo(repo)
    if (!taskId) return null
    return withLock(this.path, async () => {
      const store = await readStore(this.path)
      const record = store.repos[repoKey]
      if (!record) return null
      const issue = record.issues.find((i) => i.taskId === taskId)
      if (!issue || issue.status === "done") return null
      issue.status = "done"
      record.repoRoot = repoRoot
      await writeStore(this.path, store)
      return response(repoRoot, record)
    })
  }

  async mutate(repo: unknown, op: unknown): Promise<RepoIssues> {
    const { repoRoot, repoKey } = await resolveRepo(repo)
    if (!op || typeof op !== "object" || Array.isArray(op) || typeof (op as { type?: unknown }).type !== "string") {
      throw new Error("missing op")
    }
    return withLock(this.path, async () => {
      const store = await readStore(this.path)
      let record = store.repos[repoKey]
      if (!record) {
        record = { repoRoot, nextId: 1, issues: [] }
        store.repos[repoKey] = record
      }
      record.repoRoot = repoRoot
      const typed = op as IssueOp
      if (typed.type === "create") {
        if (typeof typed.title !== "string" || typed.title.trim().length === 0) {
          throw new Error("create requires a non-empty title")
        }
        if (typed.body !== undefined && typeof typed.body !== "string") throw new Error("body must be a string")
        record.issues = [
          {
            id: record.nextId,
            title: typed.title,
            status: "open",
            created: todayStamp(),
            body: typeof typed.body === "string" ? typed.body : "",
          },
          ...record.issues,
        ]
        record.nextId += 1
      } else if (typed.type === "setStatus") {
        if (typeof typed.id !== "number") throw new Error("setStatus requires a numeric id")
        if (!isValidStatus(typed.status)) throw new Error(`invalid status: must be one of ${ISSUE_STATUSES.join(", ")}`)
        const issue = record.issues.find((i) => i.id === typed.id)
        if (!issue) throw new Error(`no issue #${typed.id}`)
        issue.status = typed.status
      } else if (typed.type === "update") {
        if (typeof typed.id !== "number") throw new Error("update requires a numeric id")
        if (typed.title !== undefined && (typeof typed.title !== "string" || typed.title.trim().length === 0)) {
          throw new Error("title must be a non-empty string")
        }
        if (typed.body !== undefined && typeof typed.body !== "string") throw new Error("body must be a string")
        const issue = record.issues.find((i) => i.id === typed.id)
        if (!issue) throw new Error(`no issue #${typed.id}`)
        if (typeof typed.title === "string") issue.title = typed.title
        if (typeof typed.body === "string") issue.body = typed.body
      } else if (typed.type === "link") {
        if (typeof typed.id !== "number") throw new Error("link requires a numeric id")
        if (typeof typed.taskId !== "string" || typed.taskId.length === 0) {
          throw new Error("link requires a non-empty taskId")
        }
        const issue = record.issues.find((i) => i.id === typed.id)
        if (!issue) throw new Error(`no issue #${typed.id}`)
        issue.taskId = typed.taskId
      } else if (typed.type === "unlink") {
        if (typeof typed.id !== "number") throw new Error("unlink requires a numeric id")
        const issue = record.issues.find((i) => i.id === typed.id)
        if (!issue) throw new Error(`no issue #${typed.id}`)
        issue.taskId = undefined
      } else if (typed.type === "delete") {
        if (typeof typed.id !== "number") throw new Error("delete requires a numeric id")
        const nextIssues = record.issues.filter((i) => i.id !== typed.id)
        if (nextIssues.length === record.issues.length) throw new Error(`no issue #${typed.id}`)
        record.issues = nextIssues
      } else {
        throw new Error(`unknown op type: ${(typed as { type: string }).type}`)
      }
      await writeStore(this.path, store)
      return response(repoRoot, record)
    })
  }
}
