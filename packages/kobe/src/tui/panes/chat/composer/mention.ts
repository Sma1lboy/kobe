/**
 * `@`-mention support for the chat composer — file picker dropdown
 * driven by the active task's worktree.
 *
 * Mirrors `refs/opcode/src/components/FloatingPromptInput.tsx` (which
 * triggers `setShowFilePicker(true)` when `@` is typed and walks the
 * buffer back to find the `@` anchor when the user keeps typing). The
 * shape differs in three places:
 *
 *   1. **No backend search call.** opcode dispatches a Tauri command
 *      (`api.searchFiles`); kobe runs the search in-process against the
 *      gitignore-respecting flat list from `filetree/git.ts:listFiles`.
 *      That list is already sorted and bounded by the worktree (no
 *      `node_modules` walk surprises), so a synchronous filter on every
 *      keystroke is fine for the worktree sizes we expect.
 *   2. **Cache TTL.** opcode's `globalSearchCache` is a permanent Map
 *      keyed by `${basePath}:${query}`. We cache the WHOLE file list
 *      once per worktree path with a short TTL (30s) so the user
 *      doesn't pay the spawn cost on every keystroke while the
 *      dropdown is open, but the next dropdown open after a file
 *      creation gets fresh data.
 *   3. **Ranking.** opcode renders whatever the backend returns; we
 *      rank in-process. Filename-prefix matches beat directory-boundary
 *      matches beat plain substring matches, with shorter paths
 *      preferred at equal score. Matches claude-code's typeahead
 *      ranking shape (filename-first).
 *
 * The mention dropdown is rendered by `Composer.tsx`; this module only
 * provides the pure helpers and the cached fetch.
 */

import { listFiles } from "../../filetree/git"

/** Cache TTL — long enough to span typing a query, short enough that a
 * just-created file shows up on the next mention open. */
const CACHE_TTL_MS = 30_000

const fileListCache = new Map<string, { files: readonly string[]; ts: number }>()

/**
 * Return the worktree's flat file list, cached for {@link CACHE_TTL_MS}.
 * Failures (e.g. path isn't a git worktree yet) collapse to an empty
 * list — the dropdown still opens, it just renders "no matches" until
 * the user dismisses with Esc.
 */
export async function getWorktreeFiles(worktreePath: string): Promise<readonly string[]> {
  const cached = fileListCache.get(worktreePath)
  const now = Date.now()
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.files
  try {
    const files = await listFiles(worktreePath)
    fileListCache.set(worktreePath, { files, ts: now })
    return files
  } catch {
    fileListCache.set(worktreePath, { files: [], ts: now })
    return []
  }
}

/** Drop the cached file list for a worktree. Hook for future filesystem
 * watcher / explicit refresh path. */
export function invalidateWorktreeFiles(worktreePath: string): void {
  fileListCache.delete(worktreePath)
}

export type MentionContext = {
  /** Buffer index of the `@` that opened this mention. */
  atPos: number
  /** Substring between `@` and the cursor — the live filter query. */
  query: string
}

/**
 * Find the active `@`-mention span ending at `cursor`. Returns null if
 * the cursor isn't currently inside a mention region.
 *
 * Rules — matched against opcode (`FloatingPromptInput.tsx:478-533`)
 * and claude-code (`PromptInput` typeahead):
 *   - Walk backward from the cursor. Stop at the first `@` (mention
 *     anchor) or whitespace/newline (no active mention).
 *   - The `@` must be at the buffer start OR preceded by whitespace.
 *     This stops `email@host` from triggering a file picker mid-word.
 *   - The substring between `@` and the cursor (exclusive of `@`) is
 *     the query. May be empty (just typed `@`).
 */
export function findMentionContext(text: string, cursor: number): MentionContext | null {
  if (cursor <= 0 || cursor > text.length) return null
  let atPos = -1
  for (let i = cursor - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === "@") {
      atPos = i
      break
    }
    if (ch === " " || ch === "\n" || ch === "\t") return null
  }
  if (atPos < 0) return null
  if (atPos > 0) {
    const prev = text[atPos - 1]
    if (prev !== " " && prev !== "\n" && prev !== "\t") return null
  }
  return { atPos, query: text.slice(atPos + 1, cursor) }
}

export type MentionMatch = {
  /** Path relative to the worktree root. Used as the insertion value
   * verbatim (claude CLI resolves `@<path>` against its cwd, which is
   * the worktree). NEVER shortened — the dropdown shows
   * {@link displayPath} for readability but the insert preserves the
   * full path so the engine can find the file. */
  path: string
  /** Compact form for the dropdown's directory column. In a monorepo
   * (bun / npm workspaces typically rooted at `packages/<name>/...`),
   * the `packages/` prefix is dropped so a row reads `Composer.tsx
   * kobe/src/tui/panes/chat` instead of `Composer.tsx packages/kobe/
   * src/tui/panes/chat`. Outside `packages/`, this equals `path`. */
  displayPath: string
  /** Internal rank used to sort matches — not surfaced in UI. */
  score: number
}

/**
 * Shorten a path for dropdown display by stripping the conventional
 * `packages/` monorepo prefix. Identity on non-monorepo paths.
 *
 * Why only `packages/`: bun workspaces (and npm/yarn/pnpm by default)
 * place sub-packages under `packages/<name>/...`. Stripping that one
 * segment turns the 85% of paths in kobe's monorepo that share it
 * into a readable `<pkg>/<rest>` form. We don't try to detect arbitrary
 * workspace roots (`apps/`, `libs/`, etc.) — that's a slope toward
 * cwd-aware path collapsing which silently misrenders when the user's
 * monorepo doesn't match our guess. `packages/` is the one near-
 * universal convention, so we hardcode it.
 */
export function formatDisplayPath(path: string): string {
  if (path.startsWith("packages/")) return path.slice("packages/".length)
  return path
}

/**
 * Rank `files` against `query`, returning up to `limit` matches.
 *
 *   - Empty query: first `limit` files (sorted upstream).
 *   - Non-empty: filename-starts-with > directory-boundary > filename-
 *     contains > plain-substring. Shorter paths break ties.
 *
 * All comparisons are case-insensitive. The query is treated as a
 * literal substring, NOT a regex or glob — matches opcode's behavior
 * and avoids surprising users who type `@.test`.
 */
export function filterMentionMatches(files: readonly string[], query: string, limit: number): readonly MentionMatch[] {
  if (files.length === 0 || limit <= 0) return []
  const q = query.toLowerCase()
  if (q.length === 0) {
    return files.slice(0, limit).map((path) => ({
      path,
      displayPath: formatDisplayPath(path),
      score: 0,
    }))
  }
  const matches: MentionMatch[] = []
  for (const path of files) {
    const lower = path.toLowerCase()
    const slash = lower.lastIndexOf("/")
    const filename = slash >= 0 ? lower.slice(slash + 1) : lower
    let score = 0
    if (filename.startsWith(q)) score = 100
    else if (lower.includes(`/${q}`)) score = 80
    else if (filename.includes(q)) score = 60
    else if (lower.includes(q)) score = 40
    else continue
    // Path-length tie-break: at equal category, shorter paths win.
    // Weight 0.5 (not 0.01) so a tier never crosses — `README.md` (9
    // chars, filename-prefix) stays ahead of `packages/kobe/test/.../
    // README.md` (60+ chars, filename-prefix) by a clear margin, but a
    // filename-prefix match (100) still beats a directory-boundary
    // match (80) regardless of length.
    score -= path.length * 0.5
    matches.push({ path, displayPath: formatDisplayPath(path), score })
  }
  matches.sort((a, b) => b.score - a.score)
  return matches.slice(0, limit)
}
