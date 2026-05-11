/**
 * Discovery for the local `codex` CLI binary.
 *
 * Mirrors `claude-code-local/binary.ts` — same search order, just with
 * the binary name swapped. The first hit wins; throws
 * {@link CodexBinaryNotFoundError} on miss with the full list of paths
 * checked.
 */

import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export class CodexBinaryNotFoundError extends Error {
  readonly checkedPaths: readonly string[]
  constructor(checkedPaths: readonly string[]) {
    super(
      `Codex CLI binary not found. Checked: ${checkedPaths.join(
        ", ",
      )}. Ensure 'codex' is on PATH (e.g. \`brew install codex\` or the official installer).`,
    )
    this.name = "CodexBinaryNotFoundError"
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
    if (first.startsWith("codex:") && first.includes("aliased to")) {
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

export async function findCodexBinary(deps: BinaryDiscoveryDeps = defaultDeps): Promise<string> {
  const checked: string[] = []
  const tryPath = (p: string | undefined): string | undefined => {
    if (!p) return undefined
    checked.push(p)
    return deps.fileExists(p) ? p : undefined
  }

  const whichResult = deps.which("codex")
  if (whichResult) {
    checked.push(`which:${whichResult}`)
    if (deps.fileExists(whichResult)) return whichResult
  }

  const home = deps.home()

  for (const p of ["/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex", "/bin/codex"]) {
    const candidate = tryPath(p)
    if (candidate) return candidate
  }

  const nvmBin = deps.env("NVM_BIN")
  if (nvmBin) {
    const candidate = tryPath(path.join(nvmBin, "codex"))
    if (candidate) return candidate
  }

  for (const rel of [".local/bin/codex", ".bun/bin/codex", "bin/codex"]) {
    const candidate = tryPath(path.join(home, rel))
    if (candidate) return candidate
  }

  throw new CodexBinaryNotFoundError(checked)
}
