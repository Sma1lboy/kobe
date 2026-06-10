/**
 * Path / directory helpers shared by the task-creation surfaces.
 *
 * Originally grew inside `component/new-task-dialog/state.ts`; split out
 * because they aren't dialog state — they're general "turn a partially
 * typed path into suggestions" plumbing used by the new-task dialog's
 * browse-mode picker AND by `quick-task` (which needs `expandHome`
 * without dragging in the dialog state machine).
 *
 * Everything here is synchronous *filesystem* work (readdir/stat on one
 * directory), never a subprocess — cheap O(direntries) calls driven by
 * explicit user keystrokes in a dialog. Keep it that way: anything that
 * shells out belongs in `./git-snapshot.ts` (sync, whitelisted) or an
 * async spawn helper.
 */

import * as fs from "node:fs"
import * as os from "node:os"

/**
 * Expand a leading `~` to the user's home directory. Supports `~` alone
 * and `~/...`-prefixed paths only (no `~user/` lookups — rare; not
 * worth the parsing complexity here). The fs / git helpers don't expand
 * `~` themselves, so callers must resolve before validating or
 * spawning git.
 */
export function expandHome(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return os.homedir() + p.slice(1)
  return p
}

export type PathSplit = { base: string; filter: string }

/**
 * Split a partially-typed path into:
 *   - `base`: the directory we should readdir for suggestions (always
 *     ends with `/`, or is empty if the input has no directory portion
 *     yet).
 *   - `filter`: the partial leaf the user is currently typing (used as
 *     a case-insensitive prefix match against the directory listing).
 *
 *   `/Users/`           → { base: "/Users/", filter: "" }
 *   `/Users/me/proj`    → { base: "/Users/me/", filter: "proj" }
 *   `~/p`               → { base: "<home>/", filter: "p" }
 *   `~`                 → { base: "<home>/", filter: "" }
 *   `relative/path`     → { base: "relative/", filter: "path" }
 *   `foo`               → { base: "", filter: "foo" }
 *
 * `~`-relative inputs are expanded so the base is a real filesystem
 * path that readdir can use; preserving the `~/` prefix in the
 * rendered input is the caller's job — see `joinDrill`.
 */
export function splitPathForDirSuggest(value: string): PathSplit {
  if (!value) return { base: "", filter: "" }
  // Treat bare `~` as `~/` so we list the home directory.
  const normalized = value === "~" ? "~/" : value
  const expanded = expandHome(normalized)
  if (expanded.endsWith("/")) return { base: expanded, filter: "" }
  const lastSlash = expanded.lastIndexOf("/")
  if (lastSlash === -1) return { base: "", filter: expanded }
  return { base: expanded.slice(0, lastSlash + 1), filter: expanded.slice(lastSlash + 1) }
}

/**
 * Synchronously list direct subdirectories of `base`. Returns [] on any
 * fs error (path doesn't exist, permission denied, etc.) so the picker
 * silently degrades to free-text typing. Sorted alphabetically — the
 * filter (`filterSubdirs`) decides what survives.
 *
 * Hidden entries (leading `.`) are kept; `filterSubdirs` is responsible
 * for hiding them unless the user explicitly types a `.`.
 */
export function listSubdirs(base: string): readonly string[] {
  if (!base) return []
  try {
    const entries = fs.readdirSync(base, { withFileTypes: true })
    const out: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) out.push(e.name)
    }
    return out.sort((a, b) => a.localeCompare(b))
  } catch {
    return []
  }
}

/**
 * Filter the subdirectory list for the picker. Two rules:
 *
 *   1. Case-insensitive **prefix** match (not substring) — typing
 *      `proj` finds `projects/` but not `my-projects/`. Prefix matches
 *      what users expect from shell tab-completion and keeps the list
 *      tight as the user types deeper.
 *   2. Entries starting with `.` are hidden unless the filter itself
 *      starts with `.` — same convention as `ls`.
 */
export function filterSubdirs(all: readonly string[], filter: string): readonly string[] {
  const f = filter.toLowerCase()
  const showHidden = f.startsWith(".")
  const visible = showHidden ? all : all.filter((n) => !n.startsWith("."))
  if (!f) return visible
  return visible.filter((n) => n.toLowerCase().startsWith(f))
}

/**
 * Compose the new input value when the user drills into a highlighted
 * subdirectory suggestion. The `~/` prefix is preserved if the user
 * typed one (so the display stays readable) — `baseExpanded` is the
 * fs-real path readdir used, and we rewrap it in `~/` form when
 * applicable.
 */
export function joinDrill(typedValue: string, baseExpanded: string, name: string): string {
  const out = `${baseExpanded + name}/`
  if (typedValue.startsWith("~")) {
    const home = os.homedir()
    if (out === `${home}/`) return "~/"
    if (out.startsWith(`${home}/`)) return `~${out.slice(home.length)}`
  }
  return out
}
