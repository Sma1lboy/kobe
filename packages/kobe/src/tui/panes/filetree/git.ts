/**
 * Thin git wrappers for the file tree pane.
 *
 * Two narrow operations the pane needs:
 *   1. {@link listFiles} — `git ls-files --cached --others --exclude-standard --full-name`,
 *      a flat list of every gitignore-respecting file in the worktree.
 *   2. {@link statusFiles} — `git status --porcelain`, parsed into a tiny
 *      `{ path, status }` shape carrying the single-char status the pane
 *      colour-codes (M / A / D / ?).
 *
 * Implementation is intentionally separate from `src/orchestrator/worktree/git.ts`
 * — that module is owned by Stream B and is wired into worktree
 * lifecycle invariants (throws `GitCommandError`, etc.). Sharing it
 * would couple a pane to orchestrator-side code we should not touch
 * cross-stream. This wrapper is a few dozen lines of thin spawn glue
 * that matches Stream B's pattern but lives in the pane's slice.
 *
 * Implementation notes:
 *   - Git runs through `src/worktree/content.ts`, so local and remote
 *     Worktrees share one async ExecHost-backed read path.
 *   - Args always pass as an array. Never a shell string.
 *   - `cwd` is required on every call. The pane never relies on
 *     `process.cwd()` because tasks run in different worktrees
 *     concurrently.
 *   - On non-zero exit we throw — the pane shows an error empty-state.
 *     This mirrors the orchestrator's behaviour and avoids silently
 *     rendering stale data.
 */

import { parseNumstatRows, parsePorcelainRows, unquoteGitPath } from "@/lib/git-parsers"
import { readWorktreeFile, runWorktreeGit } from "../../../worktree/content.ts"

/**
 * Which diff the Changes tab shows:
 *   - `working`: uncommitted work only (`git status` / `diff HEAD`).
 *   - `branch`:  everything this task's branch adds over its base
 *                (`git diff <base>...HEAD` — the vs-base view). Because the
 *                engine contract is "commit when green", a finished task's
 *                whole output only shows up here.
 */
export type GitScope = "working" | "branch"

/** Status code our pane displays. Mirrors `git status` two-char codes
 * collapsed to a single-char headline. `T` is a typechange (a regular
 * file became a symlink or vice-versa). */
export type FileStatus = "M" | "A" | "D" | "?" | "R" | "C" | "U" | "T"

/** A single row from `git status --porcelain`. */
export type StatusEntry = {
  /** Path relative to the worktree root. */
  path: string
  /** Single-char status indicator (see {@link FileStatus}). */
  status: FileStatus
  /** Lines added vs HEAD. `null` for binary or unknown (untracked
   * counted via wc, see {@link statusFiles}). */
  added?: number | null
  /** Lines deleted vs HEAD. `null` for binary or unknown. */
  deleted?: number | null
}

/** A row from `git diff HEAD --numstat`. */
export type NumstatEntry = {
  path: string
  /** `null` for binary files (git emits `-`). */
  added: number | null
  /** `null` for binary files (git emits `-`). */
  deleted: number | null
}

/** Internal helper — drives Worktree content git, throws on non-zero. */
async function runGit(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<string> {
  if (!cwd) throw new Error("git(): cwd is required")
  const result = await runWorktreeGit(cwd, args, { signal })
  const exitCode = result.status ?? -1
  if (exitCode !== 0) {
    const stderr = (result.stderr ?? "").trim()
    const stdout = (result.stdout ?? "").trim()
    throw new Error(
      `git ${args.join(" ")} (cwd=${cwd}) exited with code ${exitCode}: ${stderr || stdout || "(no output)"}`,
    )
  }
  return result.stdout ?? ""
}

/**
 * List every file in `worktreePath` that's either tracked or untracked-
 * but-not-ignored. Equivalent to "what would `git status` know about,"
 * just flattened. Returns paths relative to the worktree root, sorted
 * alphabetically (git's default order from `ls-files` is already
 * alphabetical, but we sort defensively in case a future flag changes
 * that).
 */
export async function listFiles(worktreePath: string, signal?: AbortSignal): Promise<string[]> {
  const out = await runGit(
    ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name"],
    worktreePath,
    signal,
  )
  const lines = out.split("\n").map((l) => l.replace(/\r$/, ""))
  // De-dup: --cached + --others can in theory list the same file twice
  // when the working tree has both an index entry and an untracked
  // counterpart — rare but possible during merges.
  const set = new Set<string>()
  for (const line of lines) {
    if (line.length > 0) set.add(line)
  }
  return Array.from(set).sort()
}

/**
 * Run `git status --porcelain` in `worktreePath` and parse into
 * structured entries. Each row of porcelain output is exactly:
 *
 *   XY <path>
 *
 * where X is the index status, Y the worktree status. Untracked rows
 * are reported as `?? <path>`. We collapse the two status chars into a
 * single headline char by preferring the worktree status (Y) if non-
 * space, else the index status (X). Untracked stays `?`. Renames look
 * like `R  old -> new` — we keep only the "new" path and report `R`.
 */
export async function statusFiles(worktreePath: string, signal?: AbortSignal): Promise<StatusEntry[]> {
  // `--untracked-files=all`: without it, `git status --porcelain` collapses a
  // fully-untracked directory into ONE `?? dir/` row, which the Changes tab
  // then renders as a bare directory (no +/- stats, no file to open). `-uall`
  // expands it to the individual untracked files — matching the All tab's
  // `git ls-files --others` enumeration and respecting .gitignore the same way.
  const out = await runGit(["status", "--porcelain", "--untracked-files=all"], worktreePath, signal)
  const entries = parseStatusEntries(out)
  // Merge in `git diff HEAD --numstat` so each row carries +/- counts.
  // Untracked files don't appear in `git diff` output — for those we
  // count line counts on disk so the user still sees how many lines
  // were added. Failures fall through silently: the pane already
  // handles missing stats by rendering blanks.
  let stats: Map<string, { added: number | null; deleted: number | null }> = new Map()
  try {
    const diffOut = await runGit(["diff", "--no-color", "--numstat", "HEAD"], worktreePath, signal)
    stats = new Map(parseNumstat(diffOut).map((n) => [n.path, { added: n.added, deleted: n.deleted }]))
  } catch {
    // No HEAD yet (initial commit / unborn branch): `git diff HEAD` exits
    // non-zero because there's no HEAD to diff against. On a first commit
    // every tracked change is staged, so fall back to the staged diff so
    // the files still show real +/- counts instead of silently blank. If
    // even that fails, leave stats empty — the rows already render from the
    // porcelain pass, just with "counts unavailable" (blank) cells.
    try {
      const cachedOut = await runGit(["diff", "--no-color", "--numstat", "--cached"], worktreePath, signal)
      stats = new Map(parseNumstat(cachedOut).map((n) => [n.path, { added: n.added, deleted: n.deleted }]))
    } catch {
      stats = new Map()
    }
  }
  const merged = entries.map((e) => {
    const s = stats.get(e.path)
    if (s) return { ...e, added: s.added, deleted: s.deleted }
    return e
  })
  // Untracked files never appear in `git diff --numstat`, so the merge above
  // leaves their `added` blank. Count their lines on disk (all lines are
  // "added" against nothing; deleted stays 0) so the Changes tab shows how big
  // each new file is. Unreadable/binary reads fall through to blank rather than
  // guessing. Runs in parallel — a big untracked drop is rare but shouldn't
  // serialize dozens of reads.
  const untracked = merged.filter((e) => e.status === "?" && e.added == null)
  if (untracked.length > 0) {
    await Promise.all(
      untracked.map(async (e) => {
        const added = await countAddedLines(worktreePath, e.path, signal)
        if (added != null) {
          e.added = added
          e.deleted = 0
        }
      }),
    )
  }
  return merged
}

/**
 * Resolve the ref this worktree's branch should be diffed against for the
 * Branch scope. Prefers an explicit PR base (`prBaseRef` — the GitHub base
 * ref off `task.prStatus`, the only place kobe persists a base). Otherwise
 * asks git for the repo's default branch — `origin/HEAD`, falling back to
 * `origin/main` / `origin/master` — mirroring `daemon-worktree-adapter`'s
 * `defaultRef`. Returns `null` when none resolves (no remote / detached),
 * and the caller stays in working scope.
 */
export async function resolveBase(
  worktreePath: string,
  prBaseRef?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (prBaseRef && prBaseRef.trim().length > 0) return prBaseRef.trim()
  try {
    const head = (await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], worktreePath, signal)).trim()
    if (head.length > 0) return head
  } catch {
    // No origin/HEAD (never fetched, or no remote) — fall through to guesses.
  }
  for (const guess of ["origin/main", "origin/master"]) {
    try {
      await runGit(["rev-parse", "--verify", "--quiet", guess], worktreePath, signal)
      return guess
    } catch {
      // rev-parse --verify exits non-zero when the ref is absent; try next.
    }
  }
  return null
}

/**
 * Branch scope for the Changes tab: every file this task's branch changed
 * relative to `base`, via `git diff <base>...HEAD` (three-dot = diff against
 * the merge-base, so unrelated commits landed on the base afterward don't
 * pollute the list). Two reads keyed by path — `--name-status` for the M/A/D
 * headline, `--numstat` for the +/- counts — the same two-call merge
 * {@link statusFiles} does for working scope. Throws on a bad base so the
 * pane's error empty-state shows instead of silently rendering nothing.
 */
export async function statusFilesBranch(
  worktreePath: string,
  base: string,
  signal?: AbortSignal,
): Promise<StatusEntry[]> {
  const range = `${base}...HEAD`
  const [nameStatusOut, numstatOut] = await Promise.all([
    runGit(["diff", "--no-color", "--name-status", range], worktreePath, signal),
    runGit(["diff", "--no-color", "--numstat", range], worktreePath, signal),
  ])
  const counts = new Map(parseNumstat(numstatOut).map((n) => [n.path, { added: n.added, deleted: n.deleted }]))
  const entries: StatusEntry[] = []
  for (const { status, path } of parseNameStatus(nameStatusOut)) {
    const c = counts.get(path)
    entries.push({ path, status, added: c?.added, deleted: c?.deleted })
  }
  return entries
}

/**
 * Parse `git diff --name-status` rows into the pane's `{ status, path }`
 * headline. Each line is `<X>\t<path>` (or `R<score>\t<old>\t<new>` /
 * `C<score>\t<old>\t<new>` for renames/copies — we keep the NEW path, same
 * as the porcelain façade). Statuses the pane doesn't colour are dropped.
 */
export function parseNameStatus(raw: string): { status: FileStatus; path: string }[] {
  const out: { status: FileStatus; path: string }[] = []
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line.length === 0) continue
    const tab1 = line.indexOf("\t")
    if (tab1 < 0) continue
    const code = line[0]
    let path: string
    if (code === "R" || code === "C") {
      // R<score>\t<old>\t<new> — take the new (last) field.
      const tab2 = line.indexOf("\t", tab1 + 1)
      path = unquoteGitPath(tab2 < 0 ? line.slice(tab1 + 1) : line.slice(tab2 + 1))
    } else {
      path = unquoteGitPath(line.slice(tab1 + 1))
    }
    if (path.length === 0 || path.endsWith("/")) continue
    const status: FileStatus | null =
      code === "M" || code === "A" || code === "D" || code === "T"
        ? code
        : code === "R"
          ? "R"
          : code === "C"
            ? "C"
            : null
    if (status) out.push({ status, path })
  }
  return out
}

/**
 * Count the added-line count of an untracked file on disk. Every line is an
 * addition (there is no HEAD version), so this is just the newline count with
 * a trailing non-empty line counted as a line too — matching how `wc -l`-style
 * "lines added" reads to a user. An empty file is `0` added. Returns `null`
 * for unreadable files (missing/binary/permission) so callers leave the cell
 * blank instead of showing a wrong `+0`.
 */
async function countAddedLines(worktreePath: string, relPath: string, signal?: AbortSignal): Promise<number | null> {
  if (signal?.aborted) return null
  const text = await readWorktreeFile(worktreePath, relPath)
  if (text == null) return null
  // NUL byte => treat as binary; git wouldn't count its lines either.
  if (text.includes("\u0000")) return null
  if (text.length === 0) return 0
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") count++
  }
  // A final line without a trailing newline still counts as a line.
  if (!text.endsWith("\n")) count++
  return count
}

/**
 * Pure parser for `git diff --numstat` output, kept as the pane's typed
 * façade ({@link NumstatEntry}) over the shared {@link parseNumstatRows}.
 * The shared parser owns the hard parts — C-string unquoting and rename
 * resolution (numstat's ` => ` + brace-compaction → the canonical
 * post-rename path) — so the counts key by the same unquoted path the
 * porcelain `R` row reports. We drop the shared row's `origPath` here to
 * preserve {@link NumstatEntry}'s `{ path, added, deleted }` shape.
 */
export function parseNumstat(raw: string): NumstatEntry[] {
  return parseNumstatRows(raw).map((r) => ({ path: r.path, added: r.added, deleted: r.deleted }))
}

/**
 * Build a directory tree from a flat list of paths. Used by the All
 * tab to render files grouped by their on-disk hierarchy. The returned
 * root has an empty name/path; its children are the top-level entries
 * sorted with directories first, then files, alphabetically within each
 * group (matches VS Code / Finder default).
 */
export type TreeNode = {
  /** Path segment (last component). Empty for the root. */
  name: string
  /** Full path relative to worktree root. Empty for the root. */
  path: string
  /** Directories vs leaves. Directories may have empty `children` if
   * a file under them is filtered out — but `buildTree` never produces
   * empty dirs since paths terminate at files. */
  isDir: boolean
  children: TreeNode[]
}

export function buildTree(paths: readonly string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: [] }
  for (const p of paths) {
    if (!p) continue
    const segs = p.split("/").filter((s) => s.length > 0)
    if (segs.length === 0) continue
    let cur = root
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i] as string
      const isLast = i === segs.length - 1
      const isDir = !isLast
      let child = cur.children.find((c) => c.name === seg && c.isDir === isDir)
      if (!child) {
        child = {
          name: seg,
          path: segs.slice(0, i + 1).join("/"),
          isDir,
          children: [],
        }
        cur.children.push(child)
      }
      cur = child
    }
  }
  sortTree(root)
  return root
}

function sortTree(node: TreeNode): void {
  node.children.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  for (const c of node.children) sortTree(c)
}

/**
 * Pure parser exported for unit testing. Accepts the raw stdout of
 * `git status --porcelain` and returns the pane's typed {@link StatusEntry}
 * rows. Parsing (the `XY <path>` shape, C-string unquoting, and rename
 * `old -> new` resolution) is delegated to the shared
 * {@link parsePorcelainRows}; this façade applies only the file-tree's own
 * editorial choices: collapse the two status chars to one headline, drop
 * statuses it doesn't colour, and skip directory rows.
 */
export function parseStatusEntries(raw: string): StatusEntry[] {
  const out: StatusEntry[] = []
  for (const row of parsePorcelainRows(raw)) {
    let status: FileStatus
    if (row.x === "?" && row.y === "?") {
      status = "?"
    } else {
      // Prefer the worktree-side status for our headline; fall back to
      // index-side. Spaces collapse to the other char so "M " (staged
      // modify) reports M.
      const candidate = row.y !== " " ? row.y : row.x
      if (
        candidate === "M" ||
        candidate === "A" ||
        candidate === "D" ||
        candidate === "R" ||
        candidate === "C" ||
        candidate === "U" ||
        candidate === "T"
      ) {
        status = candidate
      } else {
        // Unknown status pair — skip rather than display garbage.
        continue
      }
    }
    const path = row.path
    if (path.length === 0) continue
    // Defensive: the Changes tab is a flat list of FILES. `-uall` expands
    // untracked directories to their files, but skip any trailing-slash dir
    // row that still slips through (older git, a future flag) so a directory
    // never renders as a change entry.
    if (path.endsWith("/")) continue
    out.push({ path, status })
  }
  return out
}
