/**
 * Tiny zero-dependency path glob matcher (KOB-256).
 *
 * Used by `kobe adopt`'s `--glob` and the New Task → Adopt tab's filter
 * to narrow discovered worktree paths. We roll our own instead of
 * `Bun.Glob` so the same code runs under the Bun runtime AND under
 * Vitest (which loads modules through Vite/node, where `import "bun"`
 * doesn't resolve).
 *
 * Supported syntax (POSIX-ish, path-segment aware):
 *   - `*`  — any run of chars except `/`
 *   - `**` — any run of chars including `/`
 *   - `?`  — a single char except `/`
 * Everything else is matched literally (regex metachars are escaped).
 */

import { basename } from "node:path"

/** Translate a glob into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"
        i++
      } else {
        re += "[^/]*"
      }
    } else if (c === "?") {
      re += "[^/]"
    } else if (c && "\\^$.|+()[]{}".includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

/**
 * Match a path against a glob, trying both the full path and its
 * basename — so a bare `feature-*` matches `/work/feature-login` without
 * the caller typing the directory. Returns false (never throws) on an
 * unparseable pattern.
 */
export function matchPathGlob(glob: string, p: string): boolean {
  let re: RegExp
  try {
    re = globToRegExp(glob)
  } catch {
    return false
  }
  return re.test(p) || re.test(basename(p))
}
