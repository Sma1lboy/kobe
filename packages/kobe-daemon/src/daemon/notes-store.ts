/**
 * Durable field notes (docs/design/dispatcher.md). v1 forwarded a note to the
 * repo's dispatcher seat and forgot it — the knowledge lived only in one
 * session's transcript, so the next worktree on the same repo rediscovered the
 * same gotcha. This store is the memory half: every filed note is appended
 * here, keyed by git common-dir so the source checkout and all its worktrees
 * share one record (the {@link IssuesStore} key convention).
 *
 * Append-only by construction — a note is a fact that WAS true when a session
 * verified it, so there is no edit or status verb to argue about. Retention is
 * a ring: the newest {@link NOTES_RETENTION_CAP} survive per repo and older
 * ones fall off. That cap is the whole eviction policy; a repo whose notes
 * genuinely outgrow it wants tagging and retrieval, not a bigger number.
 */

import { execFile } from "node:child_process"
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

/** Newest-N kept per repo. Older notes are dropped on write. */
export const NOTES_RETENTION_CAP = 50

export interface FieldNote {
  /** ISO-8601 file time. */
  readonly at: string
  /** The verified one-line conclusion, verbatim as the author filed it. */
  readonly text: string
  /** Author task id — provenance, so a reader can go read the session. */
  readonly taskId: string
  /** Author task's display label at filing time (title, else branch). */
  readonly author: string
}

interface RepoNoteRecord {
  repoRoot: string
  notes: FieldNote[]
}

interface NotesStoreFile {
  version: 1
  repos: Record<string, RepoNoteRecord>
}

export function defaultNotesStorePath(homeDir = process.env.KOBE_HOME_DIR ?? homedir()): string {
  return join(homeDir, ".kobe", "notes.json")
}

function normalizeNote(entry: unknown): FieldNote | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null
  const raw = entry as Record<string, unknown>
  if (typeof raw.text !== "string" || raw.text.length === 0) return null
  return {
    at: typeof raw.at === "string" ? raw.at : "",
    text: raw.text,
    taskId: typeof raw.taskId === "string" ? raw.taskId : "",
    author: typeof raw.author === "string" ? raw.author : "",
  }
}

async function gitCommonDir(path: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", path, "rev-parse", "--git-common-dir"])
  const dir = stdout.trim()
  return realpath(isAbsolute(dir) ? dir : resolve(path, dir))
}

async function gitMainWorktree(path: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", path, "worktree", "list", "--porcelain"])
  const first = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith("worktree "))
    ?.slice("worktree ".length)
    .trim()
  if (!first) throw new Error("repoRoot is not a git repository")
  return realpath(first)
}

async function resolveRepo(raw: string): Promise<{ repoRoot: string; repoKey: string }> {
  const absolute = resolve(raw)
  const s = await stat(absolute).catch(() => null)
  if (!s?.isDirectory()) throw new Error("repoRoot does not exist")
  const [repoRoot, repoKey] = await Promise.all([gitMainWorktree(absolute), gitCommonDir(absolute)])
  return { repoRoot, repoKey }
}

async function readStore(path: string): Promise<NotesStoreFile> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<NotesStoreFile>
    const repos: Record<string, RepoNoteRecord> = {}
    if (raw.repos && typeof raw.repos === "object") {
      for (const [key, value] of Object.entries(raw.repos)) {
        if (!value || typeof value !== "object") continue
        const record = value as Partial<RepoNoteRecord>
        repos[key] = {
          repoRoot: typeof record.repoRoot === "string" ? record.repoRoot : "",
          notes: Array.isArray(record.notes)
            ? record.notes.map(normalizeNote).filter((n): n is FieldNote => n !== null)
            : [],
        }
      }
    }
    return { version: 1, repos }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, repos: {} }
    throw err
  }
}

const locks = new Map<string, Promise<unknown>>()

/** Serialize read-modify-write on the shared file — same rationale (and the
 *  same whole-file contention unit) as the issue store's lock. */
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

export class NotesStore {
  constructor(private readonly path = defaultNotesStorePath()) {}

  /** Newest-first notes for a repo; empty for a repo that never filed one. */
  async list(repo: string): Promise<readonly FieldNote[]> {
    const { repoKey } = await resolveRepo(repo)
    return withLock(this.path, async () => (await readStore(this.path)).repos[repoKey]?.notes ?? [])
  }

  /** Append one note, newest-first, evicting past {@link NOTES_RETENTION_CAP}. */
  async append(repo: string, note: FieldNote): Promise<void> {
    const { repoRoot, repoKey } = await resolveRepo(repo)
    await withLock(this.path, async () => {
      const store = await readStore(this.path)
      const record = store.repos[repoKey] ?? { repoRoot, notes: [] }
      record.repoRoot = repoRoot
      record.notes = [note, ...record.notes].slice(0, NOTES_RETENTION_CAP)
      store.repos[repoKey] = record
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8")
      await rename(tmp, this.path)
    })
  }
}
