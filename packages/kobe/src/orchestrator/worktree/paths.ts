import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { kobeStateDir } from "../../env.ts"
import { execHostForRepo } from "../../exec/resolve.ts"
import { getRemoteRepoConfig, isRemoteRepoKey } from "../../state/repos.ts"
import { getWorktreeBaseOverride } from "../../state/worktree-base.ts"

export const KOBE_WORKTREE_ROOT_DIR = "worktrees"
export const REPO_LOCAL_KOBE_WORKTREE_ROOT_SUBPATH = ".kobe/worktrees"
export const LEGACY_KOBE_WORKTREE_ROOT_SUBPATH = ".claude/worktrees"

export const REPO_LOCAL_KOBE_MANAGED_WORKTREE_ROOT_SUBPATHS = [
  REPO_LOCAL_KOBE_WORKTREE_ROOT_SUBPATH,
  LEGACY_KOBE_WORKTREE_ROOT_SUBPATH,
] as const

function localWorktreesRoot(repo: string): string {
  return getWorktreeBaseOverride(repo) ?? path.join(kobeStateDir(), KOBE_WORKTREE_ROOT_DIR)
}

function defaultLocalWorktreesRoot(): string {
  return path.join(kobeStateDir(), KOBE_WORKTREE_ROOT_DIR)
}

export function worktreeRootFor(repo: string): string {
  if (!path.isAbsolute(repo)) {
    throw new Error(`worktreeRootFor: repo must be an absolute path, got: ${repo}`)
  }
  return path.join(localWorktreesRoot(repo), repoWorktreeDirName(repo))
}

export function managedWorktreeRootsFor(repo: string): readonly string[] {
  if (!path.isAbsolute(repo)) {
    throw new Error(`managedWorktreeRootsFor: repo must be an absolute path, got: ${repo}`)
  }
  const active = worktreeRootFor(repo)
  const fallback = path.join(defaultLocalWorktreesRoot(), repoWorktreeDirName(repo))
  const primaryRoots = active === fallback ? [active] : [active, fallback]
  return [...primaryRoots, ...REPO_LOCAL_KOBE_MANAGED_WORKTREE_ROOT_SUBPATHS.map((subpath) => path.join(repo, subpath))]
}

export function worktreePathFor(repo: string, slug: string): string {
  if (!slug || /[/\\\0]/.test(slug)) {
    throw new Error(`worktreePathFor: invalid slug: ${JSON.stringify(slug)}`)
  }
  return path.join(worktreeRootFor(repo), slug)
}

export async function listWorktreeDirNames(repo: string): Promise<string[]> {
  if (isRemoteRepoKey(repo)) {
    const basePath = getRemoteRepoConfig(repo)?.basePath
    if (!basePath) return []
    return execHostForRepo(repo).readdir(remoteWorktreeRootFor(basePath))
  }
  const names = new Set<string>()
  for (const root of managedWorktreeRootsFor(repo)) {
    try {
      for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isDirectory()) names.add(e.name)
      }
    } catch {}
  }
  return [...names]
}

export function managedWorktreeRootForPath(repo: string, candidate: string): string | null {
  if (!path.isAbsolute(repo) || !path.isAbsolute(candidate)) return null
  const target = canonicalize(candidate)
  for (const rootPath of managedWorktreeRootsFor(repo)) {
    const root = canonicalize(rootPath)
    const rel = path.relative(root, target)
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rootPath
    }
  }
  return null
}

export function isKobeManagedPath(repo: string, candidate: string): boolean {
  return managedWorktreeRootForPath(repo, candidate) !== null
}

export function remoteWorktreeRootFor(basePath: string): string {
  return `${stripTrailingSlash(basePath)}/.kobe/worktrees`
}

export function remoteWorktreePathFor(basePath: string, slug: string): string {
  if (!slug || /[/\\\0]/.test(slug)) {
    throw new Error(`remoteWorktreePathFor: invalid slug: ${JSON.stringify(slug)}`)
  }
  return `${remoteWorktreeRootFor(basePath)}/${slug}`
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.replace(/\/+$/, "") : p
}

function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

function repoWorktreeDirName(repo: string): string {
  const base = path.basename(repo) || "repo"
  const safeBase = base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo"
  const hash = createHash("sha1").update(path.resolve(repo)).digest("hex").slice(0, 12)
  return `${safeBase}-${hash}`
}
