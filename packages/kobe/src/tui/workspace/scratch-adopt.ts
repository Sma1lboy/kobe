/**
 * Scratch-task adoption decision (issue #33) — pure. A scratch shell earns a
 * project home when TWO facts line up: its live cwd resolved to a git repo,
 * and a coding harness is confirmed running in it (the foreground walk's
 * verdict — the same confidence bar the tab identity uses; a mere `cd` into
 * a repo is browsing, not working).
 *
 *   - cwd inside a KNOWN repo (a saved project or any existing task's repo)
 *     → migrate the row into that project group, silently.
 *   - cwd inside an UNFAMILIAR git repo → migrate, and ask whether to save
 *     the repo as a project (a new group either way — asking is about the
 *     savedRepos registry, not about the move).
 *   - no repo semantics → stay in Scratch.
 *
 * The caller supplies already-resolved facts; this module only decides.
 */

export interface ScratchAdoptInput {
  /** The scratch shell's live cwd resolved to its repo MAIN root, or null
   *  when the cwd is not inside a git work tree (or unreadable). */
  readonly repoRoot: string | null
  /** A coding harness is confirmed live under the shell (foreground walk). */
  readonly harnessLive: boolean
  /** Known project roots: savedRepos + every existing task's repo. */
  readonly knownRepos: ReadonlySet<string>
}

export type ScratchAdoptDecision =
  | { readonly kind: "stay" }
  | { readonly kind: "adopt"; readonly repo: string; readonly known: boolean }

export function decideScratchAdopt(input: ScratchAdoptInput): ScratchAdoptDecision {
  if (!input.repoRoot || !input.harnessLive) return { kind: "stay" }
  return { kind: "adopt", repo: input.repoRoot, known: input.knownRepos.has(input.repoRoot) }
}
