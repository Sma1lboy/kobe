import fs from "node:fs"
import path from "node:path"
import type { ExecHost } from "../../exec/exec-host.ts"
import { execHostForRepo, execHostForWorktreePath } from "../../exec/resolve.ts"
import { getRemoteRepoConfig } from "../../state/repos.ts"
import type { AdoptableWorktree, WorktreeInfo, WorktreeManager } from "../../types/worktree.ts"
import { GitCommandError, type GitRunOpts, type GitRunResult } from "./git.ts"
import { isKobeManagedPath, managedWorktreeRootForPath, remoteWorktreePathFor, worktreePathFor } from "./paths.ts"

export interface WorktreeExecDeps {
  execForRepo(repoKey: string): ExecHost
  execForPath(worktreePath: string): ExecHost
  remoteBasePath(repoKey: string): string | null
}

const defaultExecDeps: WorktreeExecDeps = {
  execForRepo: execHostForRepo,
  execForPath: execHostForWorktreePath,
  remoteBasePath(repoKey) {
    return getRemoteRepoConfig(repoKey)?.basePath ?? null
  },
}

interface ExecCtx {
  readonly exec: ExecHost
  readonly dir: string
  readonly remote: boolean
}

export class GitWorktreeManager implements WorktreeManager {
  constructor(private readonly execDeps: WorktreeExecDeps = defaultExecDeps) {}

  private ctxFor(repoKey: string): ExecCtx {
    const basePath = this.execDeps.remoteBasePath(repoKey)
    return basePath
      ? { exec: this.execDeps.execForRepo(repoKey), dir: basePath, remote: true }
      : { exec: this.execDeps.execForRepo(repoKey), dir: repoKey, remote: false }
  }

  private async runGit(exec: ExecHost, args: readonly string[], opts: GitRunOpts): Promise<GitRunResult> {
    if (!opts.cwd) {
      throw new Error("runGit(): cwd is required; refusing to inherit from process.cwd()")
    }
    const r = await exec.run(["git", ...args], { cwd: opts.cwd, env: opts.env })
    const result: GitRunResult = { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
    if (result.exitCode !== 0 && !opts.allowFail) {
      throw new GitCommandError(args, opts.cwd, result)
    }
    return result
  }
  async create(repo: string, branch: string, worktreePath: string, baseRef?: string): Promise<WorktreeInfo> {
    const ctx = this.ctxFor(repo)
    requireAbsolute("repo", ctx.dir)
    requireAbsolute("path", worktreePath)
    if (!branch) throw new Error("create(): branch must be a non-empty string")

    if (await ctx.exec.exists(worktreePath)) {
      const existing = await this.tryDescribe(ctx, worktreePath)
      if (existing) {
        if (existing.branch !== branch) {
          throw new Error(
            `worktree at ${worktreePath} is on branch '${existing.branch}', refusing to hijack to '${branch}'`,
          )
        }
        return existing
      }
      throw new Error(`create(): ${worktreePath} exists but is not a registered git worktree`)
    }

    await ctx.exec.mkdirp(path.dirname(worktreePath))

    const branchExists = await this.branchExists(ctx, branch)
    const args = branchExists
      ? ["worktree", "add", worktreePath, branch]
      : baseRef
        ? ["worktree", "add", "-b", branch, worktreePath, baseRef]
        : ["worktree", "add", "-b", branch, worktreePath]

    await this.runGit(ctx.exec, args, { cwd: ctx.dir })

    const info = await this.tryDescribe(ctx, worktreePath)
    if (!info) {
      throw new Error(`create(): git reported success but ${worktreePath} is not a worktree`)
    }
    if (info.branch !== branch) {
      throw new Error(
        `create(): post-condition failed — expected branch '${branch}' at ${worktreePath}, got '${info.branch}'`,
      )
    }
    return info
  }

  async createForTask(args: {
    repo: string
    slug: string
    branch: string
    baseRef?: string
  }): Promise<WorktreeInfo> {
    const basePath = this.execDeps.remoteBasePath(args.repo)
    const target = basePath ? remoteWorktreePathFor(basePath, args.slug) : worktreePathFor(args.repo, args.slug)
    return this.create(args.repo, args.branch, target, args.baseRef)
  }

  async remove(worktreePath: string, opts?: { readonly force?: boolean }): Promise<void> {
    requireAbsolute("path", worktreePath)
    const exec = this.execDeps.execForPath(worktreePath)
    const force = opts?.force === true

    if (!(await exec.exists(worktreePath))) {
      const repo = await this.findRepoFor(exec, worktreePath)
      if (repo) await this.runGit(exec, ["worktree", "prune"], { cwd: repo, allowFail: true })
      return
    }

    const repo = await this.findRepoFor(exec, worktreePath)
    if (!repo) {
      throw new Error(`remove(): ${worktreePath} is not a git worktree`)
    }

    if (!force) {
      const dirty = await this.isDirty(worktreePath)
      if (dirty) {
        throw new Error(
          `remove(): refusing to remove dirty worktree at ${worktreePath} (pass { force: true } to override)`,
        )
      }
    }

    const args = force ? ["worktree", "remove", "--force", worktreePath] : ["worktree", "remove", worktreePath]
    await this.runGit(exec, args, { cwd: repo })

    await this.runGit(exec, ["worktree", "prune"], { cwd: repo, allowFail: true })
  }

  async list(repo: string): Promise<readonly WorktreeInfo[]> {
    const ctx = this.ctxFor(repo)
    requireAbsolute("repo", ctx.dir)
    const out = await this.runGit(ctx.exec, ["worktree", "list", "--porcelain"], { cwd: ctx.dir })
    const all = parsePorcelain(out.stdout)

    const infos: WorktreeInfo[] = []
    for (const entry of all) {
      if (!entry.path) continue
      const callerRoot = ctx.remote
        ? remoteManagedRootForPath(ctx.dir, entry.path)
        : managedWorktreeRootForPath(repo, entry.path)
      if (!callerRoot) continue
      if (!entry.branch || entry.detached) continue
      const canonRoot = canonicalize(callerRoot)
      const canonEntry = canonicalize(entry.path)
      const rel = path.relative(canonRoot, canonEntry)
      const callerPath = path.join(callerRoot, rel)
      const dirty = await this.isDirty(entry.path)
      infos.push({
        path: callerPath,
        branch: entry.branch,
        head: entry.head ?? "",
        dirty,
      })
    }
    return infos
  }

  async listAll(repo: string): Promise<readonly AdoptableWorktree[]> {
    const ctx = this.ctxFor(repo)
    requireAbsolute("repo", ctx.dir)
    const out = await this.runGit(ctx.exec, ["worktree", "list", "--porcelain"], { cwd: ctx.dir })
    const all = parsePorcelain(out.stdout)
    const canonRepo = ctx.remote ? ctx.dir : canonicalize(ctx.dir)

    const infos: AdoptableWorktree[] = []
    for (const entry of all) {
      if (!entry.path) continue
      if (entry.bare) continue
      if (!entry.branch || entry.detached) continue
      if ((ctx.remote ? entry.path : canonicalize(entry.path)) === canonRepo) continue
      const dirty = await this.isDirty(entry.path)
      infos.push({
        path: entry.path,
        branch: entry.branch,
        head: entry.head ?? "",
        dirty,
        kobeManaged: ctx.remote
          ? remoteManagedRootForPath(ctx.dir, entry.path) !== null
          : isKobeManagedPath(repo, entry.path),
        lastActivityMs: await this.lastActivityMs(ctx.exec, entry.path),
      })
    }
    infos.sort((a, b) => b.lastActivityMs - a.lastActivityMs)
    return infos
  }

  private async lastActivityMs(exec: ExecHost, worktreePath: string): Promise<number> {
    try {
      const out = await this.runGit(exec, ["log", "-1", "--format=%ct"], { cwd: worktreePath })
      const secs = Number.parseInt(out.stdout.trim(), 10)
      if (Number.isFinite(secs) && secs > 0) return secs * 1000
    } catch {}
    if (!exec.isRemote) {
      try {
        return fs.statSync(worktreePath).mtimeMs
      } catch {}
    }
    return 0
  }

  async isDirty(worktreePath: string): Promise<boolean> {
    requireAbsolute("path", worktreePath)
    const exec = this.execDeps.execForPath(worktreePath)
    const out = await this.runGit(exec, ["status", "--porcelain"], { cwd: worktreePath })
    return out.stdout.length > 0
  }

  async currentBranch(worktreePath: string): Promise<string> {
    requireAbsolute("path", worktreePath)
    const exec = this.execDeps.execForPath(worktreePath)
    const out = await this.runGit(exec, ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath })
    const name = out.stdout.trim()
    if (!name || name === "HEAD") {
      throw new Error(`currentBranch(): ${worktreePath} is in detached-HEAD state`)
    }
    return name
  }

  async renameBranch(worktreePath: string, from: string, to: string): Promise<void> {
    requireAbsolute("path", worktreePath)
    if (from === to) return
    const exec = this.execDeps.execForPath(worktreePath)
    const repo = await this.findRepoFor(exec, worktreePath)
    if (!repo) throw new Error(`renameBranch(): ${worktreePath} is not a git worktree`)
    await this.runGit(exec, ["branch", "-m", from, to], { cwd: repo })
  }

  private async tryDescribe(ctx: ExecCtx, worktreePath: string): Promise<WorktreeInfo | null> {
    const out = await this.runGit(ctx.exec, ["worktree", "list", "--porcelain"], { cwd: ctx.dir })
    const entries = parsePorcelain(out.stdout)
    const norm = (p: string) => (ctx.remote ? p : canonicalize(p))
    const target = norm(worktreePath)
    const match = entries.find((e) => e.path && norm(e.path) === target)
    if (!match || !match.path || !match.branch || match.detached) return null
    return {
      path: worktreePath,
      branch: match.branch,
      head: match.head ?? "",
      dirty: await this.isDirty(match.path),
    }
  }

  private async branchExists(ctx: ExecCtx, branch: string): Promise<boolean> {
    const ref = `refs/heads/${branch}`
    const out = await this.runGit(ctx.exec, ["show-ref", "--verify", "--quiet", ref], {
      cwd: ctx.dir,
      allowFail: true,
    })
    return out.exitCode === 0
  }

  private async findRepoFor(exec: ExecHost, worktreePath: string): Promise<string | null> {
    try {
      const out = await this.runGit(exec, ["rev-parse", "--git-common-dir"], { cwd: worktreePath, allowFail: true })
      if (out.exitCode !== 0) return null
      const gitDir = out.stdout.trim()
      if (!gitDir) return null
      const absolute = path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreePath, gitDir)
      const base = path.basename(absolute)
      return base === ".git" ? path.dirname(absolute) : absolute
    } catch (err) {
      if (err instanceof GitCommandError) return null
      throw err
    }
  }
}

interface RawWorktree {
  path?: string
  head?: string
  branch?: string
  detached?: boolean
  bare?: boolean
}

function parsePorcelain(out: string): RawWorktree[] {
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

function remoteManagedRootForPath(basePath: string, candidate: string): string | null {
  const root = `${basePath.replace(/\/+$/, "")}/.kobe/worktrees`
  return candidate === root || candidate.startsWith(`${root}/`) ? root : null
}

function requireAbsolute(name: string, value: string): void {
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path, got: ${JSON.stringify(value)}`)
  }
}

function canonicalize(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}
