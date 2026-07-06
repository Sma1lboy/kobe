import { createHash } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"

const KOBE_WORKTREE_ROOT_DIR = "worktrees"
const REPO_LOCAL_KOBE_WORKTREE_ROOT_SUBPATH = ".kobe/worktrees"
const LEGACY_KOBE_WORKTREE_ROOT_SUBPATH = ".claude/worktrees"
const REPO_LOCAL_KOBE_MANAGED_WORKTREE_ROOT_SUBPATHS = [
  REPO_LOCAL_KOBE_WORKTREE_ROOT_SUBPATH,
  LEGACY_KOBE_WORKTREE_ROOT_SUBPATH,
] as const

function kobeStateDir(): string {
  return path.join(process.env.KOBE_HOME_DIR ?? homedir(), ".kobe")
}

function repoWorktreeDirName(repo: string): string {
  const base = path.basename(repo) || "repo"
  const safeBase = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo"
  const hash = createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 12)
  return `${safeBase}-${hash}`
}

function worktreeRootFor(repo: string): string {
  if (!path.isAbsolute(repo)) {
    throw new Error(`worktreeRootFor: repo must be an absolute path, got: ${repo}`)
  }
  return path.join(kobeStateDir(), KOBE_WORKTREE_ROOT_DIR, repoWorktreeDirName(repo))
}

function managedWorktreeRootsFor(repo: string): readonly string[] {
  if (!path.isAbsolute(repo)) {
    throw new Error(`managedWorktreeRootsFor: repo must be an absolute path, got: ${repo}`)
  }
  return [
    worktreeRootFor(repo),
    ...REPO_LOCAL_KOBE_MANAGED_WORKTREE_ROOT_SUBPATHS.map((subpath) => path.join(repo, subpath)),
  ]
}

export interface CwdMatchTask {
  readonly id: string
  readonly worktreePath?: string | null
  readonly repo?: string | null
}

function normalize(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p
}

function isAncestorOrSelf(wt: string, cwd: string): boolean {
  return cwd === wt || cwd.startsWith(`${wt}/`)
}

export function matchTaskByCwd(tasks: ReadonlyArray<CwdMatchTask>, cwd: string): string | undefined {
  const target = normalize(cwd)
  let bestId: string | undefined
  let bestLen = -1
  for (const t of tasks) {
    if (!t.worktreePath) continue
    const wt = normalize(t.worktreePath)
    if (isAncestorOrSelf(wt, target) && wt.length > bestLen) {
      bestLen = wt.length
      bestId = t.id
    }
  }
  return bestId
}

export function matchTaskByWorktreePath(tasks: ReadonlyArray<CwdMatchTask>, worktreePath: string): string | undefined {
  const target = normalize(worktreePath)
  for (const t of tasks) {
    if (t.worktreePath && normalize(t.worktreePath) === target) return t.id
  }
  return undefined
}

export function matchRepoByCwd(tasks: ReadonlyArray<CwdMatchTask>, cwd: string): string | undefined {
  const target = normalize(cwd)
  let best: string | undefined
  let bestLen = -1
  for (const t of tasks) {
    if (!t.repo) continue
    const repo = normalize(t.repo)
    if (isAncestorOrSelf(repo, target) && repo.length > bestLen) {
      bestLen = repo.length
      best = repo
    }
  }
  return best
}

export function findAdoptableWorktree(
  tasks: ReadonlyArray<CwdMatchTask>,
  cwd: string,
): { repo: string; worktreePath: string } | undefined {
  const target = normalize(cwd)
  const repos = new Set<string>()
  const known = new Set<string>()
  for (const t of tasks) {
    if (t.repo) repos.add(normalize(t.repo))
    if (t.worktreePath) known.add(normalize(t.worktreePath))
  }
  for (const repo of repos) {
    for (const root of managedWorktreeRootsFor(repo).map(normalize)) {
      const prefix = `${root}/`
      if (!target.startsWith(prefix)) continue
      const rest = target.slice(prefix.length)
      const name = rest.split("/")[0]
      if (!name) continue
      const worktreePath = `${prefix}${name}`
      if (known.has(worktreePath)) return undefined
      return { repo, worktreePath }
    }
  }
  return undefined
}
