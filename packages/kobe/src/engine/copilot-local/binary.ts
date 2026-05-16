import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export class CopilotBinaryNotFoundError extends Error {
  readonly checkedPaths: readonly string[]

  constructor(checkedPaths: readonly string[]) {
    super(
      `GitHub Copilot CLI binary not found. Checked: ${checkedPaths.join(
        ", ",
      )}. Ensure 'copilot' is on PATH (for example \`npm install -g @github/copilot\` or \`brew install copilot-cli\`).`,
    )
    this.name = "CopilotBinaryNotFoundError"
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
    if (first.startsWith("copilot:") && first.includes("aliased to")) {
      const aliasTarget = first.split("aliased to")[1]?.trim()
      return aliasTarget && existsSync(aliasTarget) ? aliasTarget : undefined
    }
    return first
  },
}

export async function findCopilotBinary(deps: BinaryDiscoveryDeps = defaultDeps): Promise<string> {
  const checked: string[] = []
  const tryPath = (p: string | undefined): string | undefined => {
    if (!p) return undefined
    checked.push(p)
    return deps.fileExists(p) ? p : undefined
  }

  const whichResult = deps.which("copilot")
  if (whichResult) {
    checked.push(`which:${whichResult}`)
    if (deps.fileExists(whichResult)) return whichResult
  }

  for (const p of ["/opt/homebrew/bin/copilot", "/usr/local/bin/copilot", "/usr/bin/copilot", "/bin/copilot"]) {
    const candidate = tryPath(p)
    if (candidate) return candidate
  }

  const nvmBin = deps.env("NVM_BIN")
  if (nvmBin) {
    const candidate = tryPath(path.join(nvmBin, "copilot"))
    if (candidate) return candidate
  }

  const home = deps.home()
  for (const rel of [".npm-global/bin/copilot", ".local/bin/copilot", ".bun/bin/copilot", "bin/copilot"]) {
    const candidate = tryPath(path.join(home, rel))
    if (candidate) return candidate
  }

  throw new CopilotBinaryNotFoundError(checked)
}
