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
 *
 * A `**` that stands as its own path segment and is immediately followed by
 * a separator (a leading globstar segment, or an interior one bounded by
 * slashes) matches ZERO or more directories, folding in the trailing
 * separator. So a "src, then a globstar segment, then task.ts" pattern
 * matches both `src/task.ts` (no intervening directory) and `src/a/task.ts`.
 * Without this fold the globstar compiled to a bare "any run" flanked by two
 * literal separators, which forced at least one intervening segment and so
 * silently hid the zero-directory case.
 */

import { basename } from "node:path"

/** Translate a glob into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = ""
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // A path-segment globstar — `**` on its own segment (preceded by
        // `/` or the start of the pattern) and immediately followed by `/`
        // — matches zero or more directories, so the trailing separator is
        // folded into the group. That lets `a/**/b` match `a/b` (no
        // intervening segment) as well as `a/x/b`. A `**` in any other
        // position keeps the loose "any run including `/`" meaning.
        const segmentStart = i === 0 || glob[i - 1] === "/"
        if (segmentStart && glob[i + 2] === "/") {
          re += "(?:.*/)?"
          i += 2 // consume the second `*` and the trailing `/`
        } else {
          re += ".*"
          i++
        }
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
