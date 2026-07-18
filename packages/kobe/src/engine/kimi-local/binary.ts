/**
 * Kimi Code CLI binary discovery. The installer puts the launcher at
 * `~/.kimi-code/bin/kimi` (verified on a live install, 2026-07-18) and
 * users may also symlink it onto PATH — so probe `which` first, then the
 * install dir, then the usual bin directories.
 */

import { spawnSync } from "node:child_process"
import { statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export class KimiBinaryNotFoundError extends Error {
  readonly checkedPaths: readonly string[]
  constructor(checkedPaths: readonly string[]) {
    super(
      `Kimi Code CLI binary not found. Checked: ${checkedPaths.join(", ")}. Ensure 'kimi' is on PATH or installed at ~/.kimi-code/bin/kimi.`,
    )
    this.name = "KimiBinaryNotFoundError"
    this.checkedPaths = checkedPaths
  }
}

export interface BinaryDiscoveryDeps {
  fileExists(p: string): boolean
  env(name: string): string | undefined
  home(): string
  which(name: string): string | undefined
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
    const cmd = process.platform === "win32" ? "where" : "which"
    const out = spawnSync(cmd, [name], { encoding: "utf8" })
    if (out.status !== 0) return undefined
    return (
      out.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)[0] || undefined
    )
  },
}

export async function findKimiBinary(deps: BinaryDiscoveryDeps = defaultDeps): Promise<string> {
  const checked: string[] = []
  const tryPath = (p: string | undefined): string | undefined => {
    if (!p) return undefined
    checked.push(p)
    return deps.fileExists(p) ? p : undefined
  }

  const whichResult = deps.which("kimi")
  if (whichResult) {
    checked.push(`which:${whichResult}`)
    if (deps.fileExists(whichResult)) return whichResult
  }

  const home = deps.home()
  for (const dir of [
    path.join(home, ".kimi-code/bin"),
    path.join(home, ".local/bin"),
    path.join(home, "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    const candidate = tryPath(path.join(dir, "kimi"))
    if (candidate) return candidate
  }

  throw new KimiBinaryNotFoundError(checked)
}
