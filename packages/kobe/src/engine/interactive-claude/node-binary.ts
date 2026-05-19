/**
 * Discovery for a Node.js binary capable of hosting the interactive
 * `claude` PTY.
 *
 * Why this exists — kobe's daemon runs under Bun, and the spike for
 * KOB-208 found that `node-pty`'s `data` callback never fires under
 * Bun 1.3.11. The hidden PTY that drives interactive `claude` must
 * therefore run inside a real Node child process (see
 * {@link ./pty-host.cjs}). `process.execPath` here is `bun`, so we have
 * to locate `node` separately.
 *
 * Search order (first hit wins):
 *   1. `$KOBE_NODE_BIN` — explicit override.
 *   2. `$PATH` via `which node`.
 *   3. `$NVM_BIN/node` (currently active nvm version).
 *   4. Homebrew + system paths.
 *
 * Throws {@link NodeBinaryNotFoundError} on miss, listing what was
 * checked so the failure is diagnosable.
 */

import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/** Thrown when no usable `node` binary can be located. */
export class NodeBinaryNotFoundError extends Error {
  readonly checkedPaths: readonly string[]
  constructor(checkedPaths: readonly string[]) {
    super(
      `Node.js binary not found (required to host the interactive claude PTY). Checked: ${checkedPaths.join(", ")}. Install Node.js, put it on PATH, or set KOBE_NODE_BIN.`,
    )
    this.name = "NodeBinaryNotFoundError"
    this.checkedPaths = checkedPaths
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function which(name: string): string | undefined {
  const cmd = process.platform === "win32" ? "where" : "which"
  const out = spawnSync(cmd, [name], { encoding: "utf8" })
  if (out.status !== 0) return undefined
  return (
    out.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0] ?? undefined
  )
}

/**
 * Locate a `node` binary. Resolves with an absolute path on success;
 * rejects with {@link NodeBinaryNotFoundError} on miss.
 *
 * Cheap (one `which`, a few stat calls) — safe to call once per spawn.
 */
export async function findNodeBinary(): Promise<string> {
  const checked: string[] = []

  const tryPath = (p: string | undefined): string | undefined => {
    if (!p) return undefined
    checked.push(p)
    return isFile(p) ? p : undefined
  }

  const override = process.env.KOBE_NODE_BIN
  if (override) {
    const hit = tryPath(override)
    if (hit) return hit
  }

  const whichResult = which("node")
  if (whichResult) {
    checked.push(`which:${whichResult}`)
    if (isFile(whichResult)) return whichResult
  }

  const nvmBin = process.env.NVM_BIN
  if (nvmBin) {
    const hit = tryPath(path.join(nvmBin, "node"))
    if (hit) return hit
  }

  const home = homedir()
  for (const p of [
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
    "/bin/node",
    path.join(home, ".local/bin/node"),
  ]) {
    const hit = tryPath(p)
    if (hit) return hit
  }

  throw new NodeBinaryNotFoundError(checked)
}
