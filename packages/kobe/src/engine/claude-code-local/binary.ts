import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

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

export interface BinaryDiscoveryDeps {
  fileExists(p: string): boolean
  env(name: string): string | undefined
  home(): string
  which(name: string): string | undefined
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
    const cmd = process.platform === "win32" ? "where" : "which"
    const out = spawnSync(cmd, [name], { encoding: "utf8" })
    if (out.status !== 0) return undefined
    const first = out.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0]
    if (!first) return undefined
    if (first.startsWith("claude:") && first.includes("aliased to")) {
      const aliasTarget = first.split("aliased to")[1]?.trim()
      return aliasTarget && existsSync(aliasTarget) ? aliasTarget : undefined
    }
    return first
  },
  readdir(p) {
    try {
      const fs = require("node:fs") as typeof import("node:fs")
      return fs.readdirSync(p)
    } catch {
      return []
    }
  },
}

export async function findClaudeBinary(deps: BinaryDiscoveryDeps = defaultDeps): Promise<string> {
  const checked: string[] = []

  const tryPath = (p: string | undefined): string | undefined => {
    if (!p) return undefined
    checked.push(p)
    return deps.fileExists(p) ? p : undefined
  }

  const whichResult = deps.which("claude")
  if (whichResult) {
    checked.push(`which:${whichResult}`)
    if (deps.fileExists(whichResult)) return whichResult
  }

  const home = deps.home()

  const localInstall = tryPath(path.join(home, ".claude", "local", "claude"))
  if (localInstall) return localInstall

  const nvmBin = deps.env("NVM_BIN")
  if (nvmBin) {
    const candidate = tryPath(path.join(nvmBin, "claude"))
    if (candidate) return candidate
  }

  const nvmRoot = path.join(home, ".nvm", "versions", "node")
  const nvmVersions = deps.readdir(nvmRoot).sort().reverse()
  for (const v of nvmVersions) {
    const candidate = tryPath(path.join(nvmRoot, v, "bin", "claude"))
    if (candidate) return candidate
  }

  for (const p of ["/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude", "/bin/claude"]) {
    const candidate = tryPath(p)
    if (candidate) return candidate
  }

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
