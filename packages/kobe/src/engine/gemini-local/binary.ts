import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export class GeminiBinaryNotFoundError extends Error {
  readonly checkedPaths: readonly string[]
  constructor(checkedPaths: readonly string[]) {
    super(
      `Gemini CLI binary not found. Checked: ${checkedPaths.join(
        ", ",
      )}. Ensure 'gemini' is on PATH (for example \`npm install -g @google/gemini-cli\`).`,
    )
    this.name = "GeminiBinaryNotFoundError"
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
    const first = out.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)[0]
    if (!first) return undefined
    if (first.startsWith("gemini:") && first.includes("aliased to")) {
      const aliasTarget = first.split("aliased to")[1]?.trim()
      return aliasTarget && existsSync(aliasTarget) ? aliasTarget : undefined
    }
    return first
  },
}

export async function findGeminiBinary(deps: BinaryDiscoveryDeps = defaultDeps): Promise<string> {
  const checked: string[] = []
  const tryPath = (p: string | undefined): string | undefined => {
    if (!p) return undefined
    checked.push(p)
    return deps.fileExists(p) ? p : undefined
  }

  const whichResult = deps.which("gemini")
  if (whichResult) {
    checked.push(`which:${whichResult}`)
    if (deps.fileExists(whichResult)) return whichResult
  }

  for (const p of ["/opt/homebrew/bin/gemini", "/usr/local/bin/gemini", "/usr/bin/gemini", "/bin/gemini"]) {
    const candidate = tryPath(p)
    if (candidate) return candidate
  }

  const nvmBin = deps.env("NVM_BIN")
  if (nvmBin) {
    const candidate = tryPath(path.join(nvmBin, "gemini"))
    if (candidate) return candidate
  }

  const home = deps.home()
  for (const rel of [".local/bin/gemini", ".bun/bin/gemini", "bin/gemini"]) {
    const candidate = tryPath(path.join(home, rel))
    if (candidate) return candidate
  }

  throw new GeminiBinaryNotFoundError(checked)
}
