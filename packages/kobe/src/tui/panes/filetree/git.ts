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

import { runWorktreeGit } from "../../../worktree/content.ts"

/** Status code our pane displays. Mirrors `git status` two-char codes
 * collapsed to a single-char headline. */
export type FileStatus = "M" | "A" | "D" | "?" | "R" | "C" | "U"

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
async function runGit(args: readonly string[], cwd: string): Promise<string> {
  if (!cwd) throw new Error("git(): cwd is required")
  const result = await runWorktreeGit(cwd, args)
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
export async function listFiles(worktreePath: string): Promise<string[]> {
  const out = await runGit(["ls-files", "--cached", "--others", "--exclude-standard", "--full-name"], worktreePath)
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
export async function statusFiles(worktreePath: string): Promise<StatusEntry[]> {
  // `--untracked-files=all`: without it, `git status --porcelain` collapses a
  // fully-untracked directory into ONE `?? dir/` row, which the Changes tab
  // then renders as a bare directory (no +/- stats, no file to open). `-uall`
  // expands it to the individual untracked files — matching the All tab's
  // `git ls-files --others` enumeration and respecting .gitignore the same way.
  const out = await runGit(["status", "--porcelain", "--untracked-files=all"], worktreePath)
  const entries = parsePorcelain(out)
  // Merge in `git diff HEAD --numstat` so each row carries +/- counts.
  // Untracked files don't appear in `git diff` output — for those we
  // count line counts on disk so the user still sees how many lines
  // were added. Failures fall through silently: the pane already
  // handles missing stats by rendering blanks.
  let stats: Map<string, { added: number | null; deleted: number | null }> | null = null
  try {
    const diffOut = await runGit(["diff", "--no-color", "--numstat", "HEAD"], worktreePath)
    stats = new Map(parseNumstat(diffOut).map((n) => [n.path, { added: n.added, deleted: n.deleted }]))
  } catch {
    // No HEAD yet (initial commit), or other diff failure — skip
    // stats rather than failing the whole list.
    stats = new Map()
  }
  return entries.map((e) => {
    const s = stats?.get(e.path)
    if (s) return { ...e, added: s.added, deleted: s.deleted }
    return e
  })
}

/**
 * Run `git diff HEAD --numstat` and parse into structured stats.
 * Useful as a primitive for callers that want raw numstat without the
 * porcelain status. Throws on non-zero exit (caller can wrap to soften).
 */
export async function numstatFiles(worktreePath: string): Promise<NumstatEntry[]> {
  const out = await runGit(["diff", "--no-color", "--numstat", "HEAD"], worktreePath)
  return parseNumstat(out)
}

/**
 * Pure parser for `git diff --numstat` output. Each line is:
 *   `<added>\t<deleted>\t<path>`
 * Binary files use `-\t-\tpath` — we surface those as `null` counts.
 * Renames look like `<a>\t<d>\told -> new` (or with `{}` braces depending
 * on git config); we keep the raw path text because the porcelain status
 * row carries the canonical post-rename path already.
 */
export function parseNumstat(raw: string): NumstatEntry[] {
  const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""))
  const out: NumstatEntry[] = []
  for (const line of lines) {
    if (line.length === 0) continue
    const tab1 = line.indexOf("\t")
    if (tab1 < 0) continue
    const tab2 = line.indexOf("\t", tab1 + 1)
    if (tab2 < 0) continue
    const a = line.slice(0, tab1)
    const d = line.slice(tab1 + 1, tab2)
    let path = line.slice(tab2 + 1)
    // Rename forms: "old -> new" or "{old => new}".
    const arrow = path.indexOf(" -> ")
    if (arrow >= 0) path = path.slice(arrow + " -> ".length)
    const added = a === "-" ? null : Number.parseInt(a, 10)
    const deleted = d === "-" ? null : Number.parseInt(d, 10)
    if (path.length === 0) continue
    out.push({
      path,
      added: Number.isNaN(added as number) ? null : added,
      deleted: Number.isNaN(deleted as number) ? null : deleted,
    })
  }
  return out
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
 * `git status --porcelain` and returns parsed entries. Lines that
 * don't match the expected `XY <path>` shape are silently dropped —
 * porcelain v1 has been stable since git 2.0, but we'd rather skip a
 * malformed row than throw and blank the pane.
 */
export function parsePorcelain(raw: string): StatusEntry[] {
  const lines = raw.split("\n").map((l) => l.replace(/\r$/, ""))
  const out: StatusEntry[] = []
  for (const line of lines) {
    if (line.length < 4) continue // need at least "XY p"
    // First two chars are the status pair, then a space, then path.
    const x = line[0]
    const y = line[1]
    const sep = line[2]
    if (x === undefined || y === undefined || sep !== " ") continue
    let path = line.slice(3)
    let status: FileStatus
    if (x === "?" && y === "?") {
      status = "?"
    } else {
      // Prefer the worktree-side status for our headline; fall back to
      // index-side. Spaces collapse to the other char so "M " (staged
      // modify) reports M.
      const candidate = y !== " " ? y : x
      if (
        candidate === "M" ||
        candidate === "A" ||
        candidate === "D" ||
        candidate === "R" ||
        candidate === "C" ||
        candidate === "U"
      ) {
        status = candidate
      } else {
        // Unknown status pair — skip rather than display garbage.
        continue
      }
    }
    if (status === "R") {
      // Rename rows look like `R  old -> new`. We display the new path.
      const arrow = path.indexOf(" -> ")
      if (arrow >= 0) path = path.slice(arrow + " -> ".length)
    }
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
