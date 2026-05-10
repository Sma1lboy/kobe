/**
 * Discovery for the local `claude` CLI binary.
 *
 * Algorithm ported from `refs/opcode/src-tauri/src/claude_binary.rs` —
 * we strip the version-comparison + DB-preference machinery (opcode
 * stores a chosen path in SQLite) and keep just the search order:
 *
 *   1. `$PATH` (the user's shell — `which claude`).
 *   2. `~/.claude/local/claude`  (Claude Code's bundled-update install).
 *   3. NVM-active (`$NVM_BIN/claude`).
 *   4. NVM versions (`~/.nvm/versions/node/<v>/bin/claude` — newest first
 *      by directory name string-sort, which is good enough for v1).
 *   5. Homebrew + system paths (`/opt/homebrew/bin`, `/usr/local/bin`,
 *      `/usr/bin`, `/bin`).
 *   6. Misc user installs (`~/.local/bin`, `~/.npm-global/bin`,
 *      `~/.yarn/bin`, `~/.bun/bin`, `~/bin`).
 *
 * The first hit wins. We do *not* run `--version` to pick the newest —
 * that costs a subprocess per candidate and the user's shell PATH is
 * almost always the right answer. If the user has a strong preference
 * they can put it on PATH.
 *
 * The function throws a typed {@link ClaudeBinaryNotFoundError} on
 * miss. The error message lists every path that was checked so the
 * user can see why discovery failed.
 */

import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/** Thrown when `findClaudeBinary` cannot locate `claude` anywhere we look. */
export class ClaudeBinaryNotFoundError extends Error {
  readonly checkedPaths: readonly string[]
  constructor(checkedPaths: readonly string[]) {
    super(
      `Claude Code binary not found. Checked: ${checkedPaths.join(
        ", ",
      )}. Ensure 'claude' is on PATH, or install at ~/.claude/local/claude.`,
    )
    this.name = "ClaudeBinaryNotFoundError"
    this.checkedPaths = checkedPaths
  }
}

/**
 * Optional FS injection for tests. Real callers don't need to pass this.
 * Tests pass a stubbed reader to assert the search order without
 * depending on the host filesystem.
 */
export interface BinaryDiscoveryDeps {
  /** Returns true if the path exists and is a regular file (or symlink to one). */
  fileExists(p: string): boolean
  /** Returns the value of a process env var, or undefined. */
  env(name: string): string | undefined
  /** Returns the user's home directory. */
  home(): string
  /** Runs `which <name>` (or `where` on Windows) and returns the first matching path, or undefined. */
  which(name: string): string | undefined
  /** Lists immediate child names of a directory, or returns []. */
  readdir(p: string): string[]
}

const defaultDeps: BinaryDiscoveryDeps = {
  fileExists(p) {
    try {
      return statSync(p).isFile()
    } catch {
      return false
    }
  },
  env(name) {
    return process.env[name]
  },
  home() {
    return homedir()
  },
  which(name) {
    // We deliberately use `command -v` style via `which`/`where` rather
    // than scanning PATH ourselves: shells often have aliases or
    // shims that show up under `which` but not under a naive PATH walk.
    const cmd = process.platform === "win32" ? "where" : "which"
    const out = spawnSync(cmd, [name], { encoding: "utf8" })
    if (out.status !== 0) return undefined
    const first = out.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0]
    if (!first) return undefined
    // macOS `which` may print "claude: aliased to /path" for shell aliases.
    if (first.startsWith("claude:") && first.includes("aliased to")) {
      const aliasTarget = first.split("aliased to")[1]?.trim()
      return aliasTarget && existsSync(aliasTarget) ? aliasTarget : undefined
    }
    return first
  },
  readdir(p) {
    try {
      // `node:fs.readdirSync` would be cleaner, but staying on a small
      // dependency surface — we use `Bun`'s/Node's builtin.
      const fs = require("node:fs") as typeof import("node:fs")
      return fs.readdirSync(p)
    } catch {
      return []
    }
  },
}

/**
 * Locate the `claude` binary on this machine.
 *
 * Resolves with an absolute path on success; rejects with
 * {@link ClaudeBinaryNotFoundError} on miss.
 *
 * The function is cheap (a single `which`, a handful of stat calls)
 * and pure aside from filesystem reads — safe to call once per spawn.
 * Callers that want caching can wrap it.
 */
export async function findClaudeBinary(deps: BinaryDiscoveryDeps = defaultDeps): Promise<string> {
  const checked: string[] = []

  const tryPath = (p: string | undefined): string | undefined => {
    if (!p) return undefined
    checked.push(p)
    return deps.fileExists(p) ? p : undefined
  }

  // 1. $PATH via `which` (user's shell PATH, including aliases).
  const whichResult = deps.which("claude")
  if (whichResult) {
    checked.push(`which:${whichResult}`)
    if (deps.fileExists(whichResult)) return whichResult
  }

  const home = deps.home()

  // 2. Claude Code's own ~/.claude/local install.
  const localInstall = tryPath(path.join(home, ".claude", "local", "claude"))
  if (localInstall) return localInstall

  // 3. NVM_BIN (currently active node version).
  const nvmBin = deps.env("NVM_BIN")
  if (nvmBin) {
    const candidate = tryPath(path.join(nvmBin, "claude"))
    if (candidate) return candidate
  }

  // 4. All NVM-installed node versions (newest by string sort).
  const nvmRoot = path.join(home, ".nvm", "versions", "node")
  const nvmVersions = deps.readdir(nvmRoot).sort().reverse()
  for (const v of nvmVersions) {
    const candidate = tryPath(path.join(nvmRoot, v, "bin", "claude"))
    if (candidate) return candidate
  }

  // 5. Homebrew + system paths.
  for (const p of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude", "/bin/claude"]) {
    const candidate = tryPath(p)
    if (candidate) return candidate
  }

  // 6. Misc per-user installs.
  for (const rel of [
    ".local/bin/claude",
    ".npm-global/bin/claude",
    ".yarn/bin/claude",
    ".bun/bin/claude",
    "bin/claude",
  ]) {
    const candidate = tryPath(path.join(home, rel))
    if (candidate) return candidate
  }

  throw new ClaudeBinaryNotFoundError(checked)
}
