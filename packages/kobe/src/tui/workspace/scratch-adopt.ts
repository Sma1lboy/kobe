/**
 * Scratch-task adoption decision (issues #33/#40) — pure. A scratch shell
 * earns a project home when TWO facts line up: its live cwd resolved to a
 * git repo, and a coding harness is confirmed running in it (the foreground
 * walk's verdict — the same confidence bar the tab identity uses; a mere
 * `cd` into a repo is browsing, not working).
 *
 * Once that bar is met, the decision de-dupes against tasks that already
 * exist (issue #40 — migrating a shell parked in the kobe main checkout
 * used to mint a second sidebar row for the same directory):
 *
 *   1. cwd equal to or inside a MANAGED task's worktree → FOLD the shell
 *      into that task as a new terminal tab. Checked first because
 *      `resolveMainRepoRoot` maps a linked worktree to the MAIN checkout —
 *      the repo-root match below would misfold into the main task.
 *   2. cwd equal to a main/dir task's directory — or the repo root the
 *      adopt would pin equal to one (a shell in a SUBDIR of the main
 *      checkout adopts the root, which is the same duplicate) → FOLD.
 *      Main rows win over dir rows: the canonical project row absorbs.
 *   3. No owner: cwd inside a KNOWN repo → migrate the row into that
 *      project group, silently. An UNFAMILIAR repo → migrate + surface the
 *      save-as-project hint (about the savedRepos registry, not the move).
 *   4. No repo semantics, or no live harness → stay in Scratch.
 *
 * The caller supplies already-resolved, canonicalized facts; this module
 * only decides.
 */

/** An unarchived, non-scratch task that could already own the shell's cwd. */
export interface ScratchOwnerTask {
  readonly id: string
  readonly kind: "main" | "task" | "dir"
  /** The task's directory (worktreePath), canonicalized like `cwd`. */
  readonly dir: string
}

export interface ScratchAdoptInput {
  /** The scratch shell's live cwd, canonicalized; null when unreadable. */
  readonly cwd: string | null
  /** The cwd resolved to its repo MAIN root, or null when the cwd is not
   *  inside a git work tree (or unreadable). */
  readonly repoRoot: string | null
  /** A coding harness is confirmed live under the shell (foreground walk). */
  readonly harnessLive: boolean
  /** Known project roots: savedRepos + every existing task's repo. */
  readonly knownRepos: ReadonlySet<string>
  /** Candidate owners for the fold check (issue #40). */
  readonly ownerTasks: readonly ScratchOwnerTask[]
}

export type ScratchAdoptDecision =
  | { readonly kind: "stay" }
  /** The cwd already belongs to `taskId` — fold the shell in, mint nothing. */
  | { readonly kind: "fold"; readonly taskId: string }
  | { readonly kind: "adopt"; readonly repo: string; readonly known: boolean }

const inDir = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

export function decideScratchAdopt(input: ScratchAdoptInput): ScratchAdoptDecision {
  if (!input.repoRoot || !input.harnessLive) return { kind: "stay" }
  const owners = input.ownerTasks.filter((task) => task.dir !== "")
  if (input.cwd) {
    const cwd = input.cwd
    const managed = owners.find((task) => task.kind === "task" && inDir(cwd, task.dir))
    if (managed) return { kind: "fold", taskId: managed.id }
  }
  for (const kind of ["main", "dir"] as const) {
    const owned = owners.find((task) => task.kind === kind && (task.dir === input.cwd || task.dir === input.repoRoot))
    if (owned) return { kind: "fold", taskId: owned.id }
  }
  return { kind: "adopt", repo: input.repoRoot, known: input.knownRepos.has(input.repoRoot) }
}
