/**
 * The POSIX login shell every kobe PTY spawns through, and the path form
 * that shell understands.
 *
 * kobe's engine-launch contract (`packages/kobe/src/engine/session-launch.ts`)
 * is a POSIX shell SCRIPT, not an argv: `trap ':' INT`, `export -p`, `$$`,
 * `${TMPDIR:-/tmp}`, `kill -TERM`, `[ -f ]`, `exec "${SHELL:-/bin/sh}"`.
 * Every engine tab and every embedded terminal is spawned through it, so
 * porting it to a second cmd/PowerShell dialect would fork the single code
 * path the whole product runs on — twice the surface, twice the drift.
 *
 * Windows therefore gets a real POSIX shell rather than a second dialect:
 * Git for Windows ships bash plus full coreutils, and kobe is git-worktree
 * native, so every machine that can run kobe at all already has it. This
 * module is the ONLY place that knows any of that — callers keep passing
 * `-il` / `-ilc` and keep composing one POSIX script.
 *
 * POSIX behaviour is deliberately unchanged: each call site passes the
 * fallback it always used (`/bin/zsh`, `/bin/bash`, `/bin/sh`), so this is
 * additive on macOS and Linux.
 */

import { existsSync } from "node:fs"

/** Where Git for Windows puts bash, in install-likelihood order. */
function windowsBashCandidates(env) {
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Programs`]
  return roots.filter(Boolean).map((root) => `${root}\\Git\\bin\\bash.exe`)
}

/** Named in the spawn error when Git for Windows is missing entirely. */
const WINDOWS_BASH_FALLBACK = "C:\\Program Files\\Git\\bin\\bash.exe"

/** @type {Map<string, string>} */
const cache = new Map()

/**
 * Resolve the login shell for a PTY.
 *
 * @param {object} [options]
 * @param {string} [options.fallback] Shell to use on POSIX when `$SHELL` is unset.
 * @param {NodeJS.Platform} [options.platform]
 * @param {Readonly<Record<string, string | undefined>>} [options.env]
 * @returns {string}
 */
export function resolveLoginShell(options = {}) {
  const fallback = options.fallback ?? "/bin/bash"
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  // Only the ambient (real platform + real env) answer is cacheable; the
  // injected forms exist for tests and must stay honest.
  const cacheable = platform === process.platform && env === process.env
  if (cacheable) {
    const hit = cache.get(fallback)
    if (hit) return hit
  }
  const resolved = resolveUncached(fallback, platform, env)
  if (cacheable) cache.set(fallback, resolved)
  return resolved
}

function resolveUncached(fallback, platform, env) {
  const explicit = env.SHELL?.trim()
  if (platform !== "win32") return explicit || fallback
  // A SHELL inherited from a Git Bash parent is an MSYS path (`/usr/bin/bash`)
  // that the Windows process API cannot spawn, so only honour one the Windows
  // filesystem can actually see.
  if (explicit && existsSync(explicit)) return explicit
  for (const candidate of windowsBashCandidates(env)) {
    if (existsSync(candidate)) return candidate
  }
  // Deliberately NOT bare `bash.exe`: System32\bash.exe is the WSL launcher,
  // which would drop the session into a Linux filesystem that cannot see the
  // Windows worktree. Naming the real path makes the spawn error say so.
  return WINDOWS_BASH_FALLBACK
}

/**
 * Convert a path for embedding INTO a shell script. Git Bash rejects
 * backslash paths in `[ -f ]` / `mkdir -p`, so Windows paths become MSYS
 * form (`C:\a\b` → `/c/a/b`). Identity everywhere else.
 *
 * Only for values interpolated into a script — a `cwd` handed to node-pty
 * must stay a native Windows path.
 *
 * @param {string} filePath
 * @param {NodeJS.Platform} [platform]
 * @returns {string}
 */
export function toPosixPath(filePath, platform = process.platform) {
  if (platform !== "win32") return filePath
  const slashed = filePath.replace(/\\/g, "/")
  const drive = /^([A-Za-z]):\//.exec(slashed)
  return drive ? `/${drive[1].toLowerCase()}${slashed.slice(2)}` : slashed
}
