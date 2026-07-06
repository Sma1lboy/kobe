/**
 * Companion to `repos.test.ts` covering the repo-root resolution + the
 * cross-process KV accessors that file leaves untouched.
 *
 * Why these matter: `resolveRepoRoot` decides what path a saved repo is
 * KEYED by — a wrong answer makes `kobe add` from a monorepo subdir store
 * the subdir (FileTree then renders rooted at the wrong toplevel), and
 * `resolveMainRepoRoot` is what keeps scripted task creation from nesting
 * a new worktree under another task's worktree. Real `git` repos in temp
 * dirs; the KV blob is isolated via `KOBE_HOME_DIR`.
 */

import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import {
  addSavedRepo,
  getPersistedString,
  getRemoteRepos,
  getSavedRepos,
  isRemoteProjectsEnabled,
  normalizeSavedRepos,
  remoteRepoKey,
  resolveMainRepoRoot,
  resolveRepoRoot,
  setPersistedString,
  statePath,
} from "../../src/state/repos.ts"

let tmpHome: string
let originalHome: string | undefined
const tempDirs: string[] = []

function tempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  tempDirs.push(d)
  return d
}

/** git init + one commit (worktree add needs a commit to branch from). */
function initRepo(dir: string): void {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
  const run = (args: string[]) => {
    const r = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" })
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`)
  }
  run(["init", "-b", "main"])
  run(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"])
}

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-roots-home-"))
  tempDirs.push(tmpHome)
  originalHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpHome
})

afterEach(() => {
  if (originalHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  else process.env.KOBE_HOME_DIR = originalHome
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe("resolveRepoRoot", () => {
  test("resolves a monorepo subdirectory to the git toplevel", () => {
    const repo = tempDir("kobe-root-repo-")
    initRepo(repo)
    const sub = path.join(repo, "packages", "kobe")
    fs.mkdirSync(sub, { recursive: true })
    expect(fs.realpathSync(resolveRepoRoot(sub))).toBe(fs.realpathSync(repo))
  })

  test("returns the input path when it already IS the toplevel (no realpath rewrite)", () => {
    const repo = tempDir("kobe-root-top-")
    initRepo(repo)
    // macOS: os.tmpdir() gives /var/… while git prints /private/var/… — the
    // realpath comparison must keep the user's spelling, not canonicalize it.
    expect(resolveRepoRoot(repo)).toBe(repo)
  })

  test("returns the input for a non-repo directory", () => {
    const plain = tempDir("kobe-root-plain-")
    expect(resolveRepoRoot(plain)).toBe(plain)
  })

  test("passes a remote ssh:// key through untouched", () => {
    expect(resolveRepoRoot("ssh://jc@box:22")).toBe("ssh://jc@box:22")
  })
})

describe("resolveMainRepoRoot", () => {
  test("resolves a linked worktree to the PRIMARY checkout, not the worktree", () => {
    const repo = tempDir("kobe-main-repo-")
    initRepo(repo)
    const wt = path.join(tempDir("kobe-main-wt-"), "wt1")
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }
    const r = spawnSync("git", ["worktree", "add", wt, "-b", "feature-x"], { cwd: repo, env, encoding: "utf8" })
    expect(r.status).toBe(0)
    expect(fs.realpathSync(resolveMainRepoRoot(wt))).toBe(fs.realpathSync(repo))
    // git rev-parse --show-toplevel from the worktree would have said wt:
    expect(fs.realpathSync(resolveRepoRoot(wt))).toBe(fs.realpathSync(wt))
  })

  test("falls back to resolveRepoRoot outside a git repo, and passes ssh:// through", () => {
    const plain = tempDir("kobe-main-plain-")
    expect(resolveMainRepoRoot(plain)).toBe(plain)
    expect(resolveMainRepoRoot("ssh://jc@box")).toBe("ssh://jc@box")
  })
})

describe("getPersistedString / setPersistedString", () => {
  test("round-trips a string and returns undefined for absent or non-string values", () => {
    expect(getPersistedString("lastSelectedVendor")).toBeUndefined()
    setPersistedString("lastSelectedVendor", "codex")
    expect(getPersistedString("lastSelectedVendor")).toBe("codex")

    fs.writeFileSync(statePath(), JSON.stringify({ lastSelectedVendor: 42 }))
    expect(getPersistedString("lastSelectedVendor")).toBeUndefined()
  })
})

describe("normalizeSavedRepos", () => {
  test("rewrites subdir entries to their toplevel and de-dupes collapsed duplicates", () => {
    const repo = tempDir("kobe-norm-repo-")
    initRepo(repo)
    const subA = path.join(repo, "packages", "a")
    const subB = path.join(repo, "packages", "b")
    fs.mkdirSync(subA, { recursive: true })
    fs.mkdirSync(subB, { recursive: true })
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify({ savedRepos: [subA, subB, "ssh://jc@box"], activeTheme: "claude" }))

    normalizeSavedRepos()

    const after = JSON.parse(fs.readFileSync(statePath(), "utf8")) as Record<string, unknown>
    // Both subdirs collapse to ONE toplevel entry (git's canonical spelling);
    // the remote key is untouched; sibling keys survive.
    expect(after.savedRepos).toEqual([resolveRepoRoot(subA), "ssh://jc@box"])
    expect(fs.realpathSync(resolveRepoRoot(subA))).toBe(fs.realpathSync(repo))
    expect(after.activeTheme).toBe("claude")
  })

  test("no-op when every entry is already canonical (file left untouched)", () => {
    addSavedRepo("/already/canonical")
    const before = fs.statSync(statePath()).mtimeMs
    normalizeSavedRepos()
    expect(getSavedRepos()).toEqual(["/already/canonical"])
    expect(fs.statSync(statePath()).mtimeMs).toBe(before)
  })
})

describe("remote projects", () => {
  test("remoteRepoKey includes the port only when set", () => {
    expect(remoteRepoKey("box", "jc", 2222)).toBe("ssh://jc@box:2222")
    expect(remoteRepoKey("box", "jc")).toBe("ssh://jc@box")
  })

  test("isRemoteProjectsEnabled defaults to false and reads the experimental flag", () => {
    expect(isRemoteProjectsEnabled()).toBe(false)
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify({ "experimental.remoteProjects": true }))
    expect(isRemoteProjectsEnabled()).toBe(true)
  })

  test("getRemoteRepos returns {} when absent and rejects a malformed blob", () => {
    expect(getRemoteRepos()).toEqual({})
    fs.mkdirSync(path.dirname(statePath()), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify({ remoteRepos: ["not", "a", "map"] }))
    expect(getRemoteRepos()).toEqual({})
    const config = { host: "box", user: "jc", basePath: "/srv", auth: { kind: "key" as const } }
    fs.writeFileSync(statePath(), JSON.stringify({ remoteRepos: { "ssh://jc@box": config } }))
    expect(getRemoteRepos()).toEqual({ "ssh://jc@box": config })
  })
})
