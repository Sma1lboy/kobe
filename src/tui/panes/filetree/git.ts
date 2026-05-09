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
 *   - We use Node's `child_process.spawnSync`. The brief says to "use
 *     `Bun.spawnSync`, matching B's pattern" — but B's actual file uses
 *     `child_process.spawnSync` because the test runner (vitest) hosts
 *     under Node and `Bun` is undefined there. Matching B's *real*
 *     pattern keeps the unit tests runnable under both runtimes. The
 *     production binary runs under Bun, where Node's `child_process`
 *     also works (Bun ships a compatible shim). Same trade-off, same
 *     answer.
 *   - Args always pass as an array. Never a shell string. `shell: false`
 *     defends against any upstream layer that might flip the default.
 *   - `cwd` is required on every call. The pane never relies on
 *     `process.cwd()` because tasks run in different worktrees
 *     concurrently.
 *   - On non-zero exit we throw — the pane shows an error empty-state.
 *     This mirrors the orchestrator's behaviour and avoids silently
 *     rendering stale data.
 *   - We export `spawnGit` as a named symbol so unit tests can mock it
 *     via `vi.spyOn` (vitest cannot stub a top-level `import` directly,
 *     but it can stub a property of the same module's exported object).
 */

import { type SpawnSyncReturns, spawnSync as nodeSpawnSync } from "node:child_process"

/** Status code our pane displays. Mirrors `git status` two-char codes
 * collapsed to a single-char headline. */
export type FileStatus = "M" | "A" | "D" | "?" | "R" | "C" | "U"

/** A single row from `git status --porcelain`. */
export type StatusEntry = {
  /** Path relative to the worktree root. */
  path: string
  /** Single-char status indicator (see {@link FileStatus}). */
  status: FileStatus
}

/**
 * Wrapper around `child_process.spawnSync` that we expose as a named
 * export so tests can replace it. Production callers should prefer
 * {@link listFiles} and {@link statusFiles}; this is the seam.
 */
export const gitWrapper = {
  spawnSync(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
    return nodeSpawnSync("git", [...args], {
      cwd,
      encoding: "utf8",
      shell: false,
    })
  },
}

/** Internal helper — drives gitWrapper.spawnSync, throws on non-zero. */
function runGit(args: readonly string[], cwd: string): string {
  if (!cwd) throw new Error("git(): cwd is required")
  const result = gitWrapper.spawnSync(args, cwd)
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
  const out = runGit(["ls-files", "--cached", "--others", "--exclude-standard", "--full-name"], worktreePath)
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
  const out = runGit(["status", "--porcelain"], worktreePath)
  return parsePorcelain(out)
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
    out.push({ path, status })
  }
  return out
}
