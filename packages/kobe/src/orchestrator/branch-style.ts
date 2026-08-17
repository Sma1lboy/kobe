/**
 * Repo-convention branch naming (issue #39).
 *
 * A managed task's auto branch used to be `rove/<slug>-<id6>`, which baked
 * the tool's brand into the user's git history. Instead we scan the target
 * repo's existing branch names (local + origin) and infer its dominant
 * naming style — conventional type prefixes (`feat/`, `fix/`, `chore/`, …)
 * or bare kebab slugs — then apply that style to a slug derived from the
 * task title. Guarantees:
 *
 *   - The generated name NEVER contains "rove" or "kobe" (brand tokens are
 *     stripped from the slug; prefixes only come from the conventional set).
 *   - Collisions get a short `-2` / `-3` suffix, not a machine ulid tail.
 *   - No inferable convention (empty repo, no branches) → bare kebab slug.
 *
 * Everything here is pure; the coordinator supplies the branch-name list
 * and the taken-set.
 */

/**
 * Conventional-commit-style branch type prefixes. Used both to recognise a
 * "typed" repo convention and to lift a leading type word out of a title
 * ("Fix login flow" → `fix/login-flow` in a typed repo).
 */
const TYPE_PREFIXES = new Set([
  "feat",
  "feature",
  "fix",
  "bugfix",
  "hotfix",
  "chore",
  "docs",
  "doc",
  "refactor",
  "test",
  "tests",
  "ci",
  "build",
  "perf",
  "style",
  "revert",
  "release",
])

/** Tool-brand tokens that must never appear in a generated branch name. */
const BRAND_TOKENS = new Set(["rove", "kobe"])

export type BranchStyle = { readonly kind: "bare" } | { readonly kind: "typed"; readonly defaultPrefix: string }

/**
 * Infer the repo's dominant branch-naming style from its branch names
 * (local + origin, remote prefix already stripped). Votes: a name with a
 * conventional type prefix counts as "typed"; a name with no slash counts
 * as "bare"; other prefixes (`user/…`, `backup/…`, legacy `rove/…`) don't
 * vote — they're neither convention. Ties break toward "typed" so a repo
 * whose only branches are `main` + `feat/x` reads as typed (the default
 * branch always votes bare). No votes at all → bare.
 */
export function inferBranchStyle(names: readonly string[]): BranchStyle {
  const typed = new Map<string, number>()
  let bare = 0
  for (const raw of new Set(names)) {
    const name = raw.trim()
    if (!name || name === "HEAD") continue
    const slash = name.indexOf("/")
    if (slash === -1) {
      bare += 1
      continue
    }
    const prefix = name.slice(0, slash)
    if (TYPE_PREFIXES.has(prefix)) typed.set(prefix, (typed.get(prefix) ?? 0) + 1)
  }
  let typedTotal = 0
  for (const n of typed.values()) typedTotal += n
  if (typedTotal === 0 || typedTotal < bare) return { kind: "bare" }
  // Most common prefix wins; ties resolve alphabetically for determinism.
  let best = ""
  let bestN = 0
  for (const [prefix, n] of typed) {
    if (n > bestN || (n === bestN && (best === "" || prefix < best))) {
      best = prefix
      bestN = n
    }
  }
  return { kind: "typed", defaultPrefix: best }
}

/** Kebab tokens from a title, with brand tokens removed. */
function slugTokens(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter((t) => t.length > 0 && !BRAND_TOKENS.has(t))
}

/** Join tokens, cap at 32 chars, and re-trim a hyphen the cap can expose. */
function capSlug(tokens: readonly string[]): string {
  return tokens.join("-").slice(0, 32).replace(/-+$/, "")
}

/**
 * Derive a convention-following branch name from a task title. In a typed
 * repo, a leading type word in the title becomes the prefix ("Fix login
 * flow" → `fix/login-flow`); otherwise the repo's most common prefix is
 * used. In a bare repo the slug stands alone. Empty slug → "task".
 */
export function deriveConventionBranch(title: string, style: BranchStyle): string {
  const tokens = slugTokens(title)
  if (style.kind === "typed") {
    const first = tokens[0]
    const prefix = first !== undefined && TYPE_PREFIXES.has(first) ? (tokens.shift() as string) : style.defaultPrefix
    return `${prefix}/${capSlug(tokens) || "task"}`
  }
  return capSlug(tokens) || "task"
}

/**
 * First free name among `base`, `base-2` … `base-99`; past that (taken-set
 * pathology) fall back to a short task-id suffix so allocation never fails.
 */
export function uniqueBranchName(base: string, taken: ReadonlySet<string>, taskId: string): string {
  if (!taken.has(base)) return base
  for (let n = 2; n <= 99; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${taskId.slice(-6).toLowerCase()}`
}
