/**
 * kobe web — git diff route.
 *
 * A read-only browser-facing endpoint that surfaces the working-tree changes
 * of a task's git worktree (a task = one worktree). The lead composes
 * `handleDiffRequest` into `server.ts`'s `fetch` alongside the existing
 * `/events` and `/api/rpc` routes.
 *
 *   GET /api/diff?worktreePath=<abspath>
 *     → 200 { files: DiffFile[], raw: string }
 *     → 400 { error }  missing / non-absolute / non-existent path
 *     → 500 { error }  not a git repo, or git failed
 *
 * Response shape (also mirrored client-side in kobe-web/src/lib/diff.ts):
 *
 *   interface DiffFile {
 *     path: string         // repo-relative path (the post-rename path for renames)
 *     status: string       // human label: "modified" | "added" | "deleted" |
 *                          //   "renamed" | "untracked" | "copied" | "type changed"
 *     staged: boolean      // change is in the index (vs. only the working tree)
 *     patch: string        // unified diff (`git diff` output) for this file;
 *                          //   for untracked files, a synthesized all-added patch
 *   }
 *   { files: DiffFile[], raw: string }   // raw = concatenated unstaged+staged diff
 *
 * Implementation notes:
 * - Uses `Bun.spawn` to run git in the worktree dir (matches server.ts's
 *   `pidsOnPort` helper style). All git invocations pass `--no-color`.
 * - `status --porcelain=v1 -z` enumerates files (NUL-delimited so paths with
 *   spaces/newlines survive); we then slice per-file patches out of the full
 *   `git diff` / `git diff --staged` text so we run git a bounded number of
 *   times rather than once per file.
 */

const GIT_TIMEOUT_MS = 15_000

/**
 * Max concurrent `git diff --no-index` spawns for untracked files. Bounded so a
 * worktree with hundreds of untracked files doesn't fork-bomb git, while still
 * collapsing the previous one-spawn-at-a-time wall.
 */
const UNTRACKED_DIFF_CONCURRENCY = 8

interface SpawnResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

/** Run `git <args>` in `cwd`. Captures stdout/stderr; never throws. */
async function runGit(cwd: string, args: string[]): Promise<SpawnResult> {
  try {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }, GIT_TIMEOUT_MS)
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(timer)
    return { ok: code === 0, stdout, stderr, code }
  } catch (err) {
    return { ok: false, stdout: "", stderr: err instanceof Error ? err.message : String(err), code: -1 }
  }
}

export interface DiffFile {
  path: string
  status: string
  staged: boolean
  patch: string
}

export interface DiffResult {
  files: DiffFile[]
  raw: string
}

/** Map a one-char porcelain XY status code to a human label. */
export function statusLabel(code: string): string {
  switch (code) {
    case "M":
      return "modified"
    case "A":
      return "added"
    case "D":
      return "deleted"
    case "R":
      return "renamed"
    case "C":
      return "copied"
    case "T":
      return "type changed"
    case "U":
      return "unmerged"
    case "?":
      return "untracked"
    default:
      return "changed"
  }
}

/**
 * Split a multi-file `git diff` blob into per-file patches keyed by the
 * post-image path. Each file's hunk starts at a `diff --git a/… b/…` line; we
 * read the destination path from the `+++ b/<path>` marker when present (it
 * handles renames and quoted/space paths better than parsing the header).
 */
export function splitDiffByFile(diff: string): Map<string, string> {
  const byFile = new Map<string, string>()
  if (!diff) return byFile
  // Each chunk begins with "diff --git". Keep the delimiter on each chunk.
  const chunks = diff.split(/(?=^diff --git )/m)
  for (const chunk of chunks) {
    if (!chunk.startsWith("diff --git")) continue
    let path: string | null = null
    const plus = chunk.match(/^\+\+\+ b\/(.*)$/m)
    if (plus && plus[1] !== "/dev/null") {
      path = plus[1]
    } else {
      // Deleted file (+++ /dev/null) or no body — fall back to the header's b/.
      const header = chunk.match(/^diff --git a\/.* b\/(.*)$/m)
      if (header) path = header[1]
    }
    if (!path) continue
    byFile.set(unquoteGitPath(path), chunk.endsWith("\n") ? chunk : `${chunk}\n`)
  }
  return byFile
}

/** Git quotes paths with special chars as C-style strings ("a\tb"); undo that. */
function unquoteGitPath(p: string): string {
  if (!(p.startsWith('"') && p.endsWith('"'))) return p
  const inner = p.slice(1, -1)
  return inner.replace(/\\([\\"nt])/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : c))
}

/**
 * Map `items` through `fn` with at most `limit` concurrent invocations,
 * preserving input→output order. A worker pool, not `Promise.all`: a worktree
 * with hundreds of untracked files would fork-bomb git under unbounded
 * parallelism, so we cap the in-flight count. Results land at the same index
 * as their input regardless of completion order.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  const width = Math.max(1, Math.min(limit, items.length))
  let next = 0
  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}

/** Build a synthetic all-added unified patch for an untracked file. */
async function untrackedPatch(cwd: string, relPath: string): Promise<string> {
  // `git diff --no-index /dev/null <file>` produces a real unified diff with
  // proper +/- markers; run it relative to the worktree. It exits 1 on diff,
  // which is expected, so we use stdout regardless of code.
  const res = await runGit(cwd, ["diff", "--no-color", "--no-index", "--", "/dev/null", relPath])
  if (res.stdout.trim()) return res.stdout.endsWith("\n") ? res.stdout : `${res.stdout}\n`
  return ""
}

/**
 * Diff route handler. Returns `null` for non-diff requests so the caller can
 * fall through to its other routes.
 */
export async function handleDiffRequest(req: Request, url: URL): Promise<Response | null> {
  if (url.pathname !== "/api/diff") return null
  if (req.method !== "GET") return Response.json({ error: "method not allowed" }, { status: 405 })

  const rawParam = url.searchParams.get("worktreePath")
  if (!rawParam) return Response.json({ error: "missing worktreePath" }, { status: 400 })

  let worktreePath: string
  try {
    worktreePath = decodeURIComponent(rawParam)
  } catch {
    return Response.json({ error: "invalid worktreePath encoding" }, { status: 400 })
  }
  if (!worktreePath.startsWith("/")) {
    return Response.json({ error: "worktreePath must be an absolute path" }, { status: 400 })
  }

  // Validate the path exists and is a directory.
  try {
    const stat = await Bun.file(worktreePath).stat()
    if (!stat.isDirectory()) {
      return Response.json({ error: "worktreePath is not a directory" }, { status: 400 })
    }
  } catch {
    return Response.json({ error: "worktreePath does not exist" }, { status: 400 })
  }

  // Confirm it's inside a git work tree.
  const inside = await runGit(worktreePath, ["rev-parse", "--is-inside-work-tree"])
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return Response.json({ error: `not a git work tree: ${inside.stderr.trim() || worktreePath}` }, { status: 500 })
  }

  const [statusRes, unstaged, staged] = await Promise.all([
    runGit(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(worktreePath, ["diff", "--no-color"]),
    runGit(worktreePath, ["diff", "--no-color", "--staged"]),
  ])

  if (!statusRes.ok) {
    return Response.json({ error: `git status failed: ${statusRes.stderr.trim()}` }, { status: 500 })
  }

  const unstagedByFile = splitDiffByFile(unstaged.stdout)
  const stagedByFile = splitDiffByFile(staged.stdout)

  // Parse NUL-delimited porcelain v1. Each record is "XY <path>"; a rename/copy
  // (R/C) is followed by a second NUL-terminated field (the origin path).
  const records = statusRes.stdout.split("\0")
  const files: DiffFile[] = []
  // Untracked files need a `git diff --no-index` spawn each; collect them and
  // resolve their patches through a bounded pool after the parse pass instead
  // of awaiting one-at-a-time in the loop. The tracked-file patches are sliced
  // out of the already-fetched diff blobs, so they cost nothing here.
  const untrackedJobs: Array<{ fileIndex: number; path: string }> = []
  for (let i = 0; i < records.length; i++) {
    const rec = records[i]
    if (!rec) continue
    const x = rec[0] ?? " "
    const y = rec[1] ?? " "
    const path = rec.slice(3)
    if (!path) continue
    // Rename/copy records consume the next field (the source path) — skip it.
    if (x === "R" || x === "C" || y === "R" || y === "C") i++

    const untracked = x === "?" && y === "?"
    // Prefer the index status code (X) when present, else the worktree code (Y).
    const code = x !== " " && x !== "?" ? x : y
    const staged = x !== " " && x !== "?"

    let patch = ""
    if (untracked) {
      // Filled in below by the bounded pool; record the slot to populate.
      untrackedJobs.push({ fileIndex: files.length, path })
    } else {
      patch = stagedByFile.get(path) ?? unstagedByFile.get(path) ?? ""
      // A file changed in both index and worktree: show both hunks.
      if (stagedByFile.has(path) && unstagedByFile.has(path)) {
        patch = `${stagedByFile.get(path)}${unstagedByFile.get(path)}`
      }
    }

    files.push({
      path,
      status: untracked ? "untracked" : statusLabel(code),
      staged,
      patch,
    })
  }

  // Spawn `git diff --no-index` for untracked files at most ~8 at a time.
  if (untrackedJobs.length > 0) {
    const patches = await mapPool(untrackedJobs, UNTRACKED_DIFF_CONCURRENCY, (job) =>
      untrackedPatch(worktreePath, job.path),
    )
    for (let j = 0; j < untrackedJobs.length; j++) {
      files[untrackedJobs[j].fileIndex].patch = patches[j]
    }
  }

  files.sort((a, b) => a.path.localeCompare(b.path))

  const raw = [staged.stdout, unstaged.stdout].filter(Boolean).join("\n")
  const result: DiffResult = { files, raw }
  return Response.json(result)
}
