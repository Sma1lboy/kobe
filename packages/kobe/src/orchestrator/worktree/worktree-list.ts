/**
 * Parser for `git worktree list --porcelain` output. Pure. Named to stay
 * unambiguous next to the two OTHER porcelain parsers in the tree (the
 * `git status --porcelain` ones in `tui/panes/filetree/git.ts` and
 * `tui/panes/sidebar/worktree-changes.ts`), which read a different format.
 */

export interface RawWorktree {
  path?: string
  head?: string
  branch?: string
  detached?: boolean
  bare?: boolean
}

/**
 * Parse `git worktree list --porcelain` output into structured
 * entries. Format reference (`man git-worktree`, "PORCELAIN FORMAT"):
 *   worktree <path>
 *   HEAD <sha>
 *   branch refs/heads/<name>     # OR
 *   detached
 *   bare                         # OR
 *   locked [<reason>]
 *   prunable [<reason>]
 *   <blank line separates records>
 */
export function parseWorktreeListPorcelain(out: string): RawWorktree[] {
  const records: RawWorktree[] = []
  let current: RawWorktree | null = null
  for (const rawLine of out.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line === "") {
      if (current) records.push(current)
      current = null
      continue
    }
    if (!current) current = {}
    if (line.startsWith("worktree ")) {
      current.path = line.slice("worktree ".length)
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length)
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length)
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
    } else if (line === "detached") {
      current.detached = true
    } else if (line === "bare") {
      current.bare = true
    }
  }
  if (current) records.push(current)
  return records
}
