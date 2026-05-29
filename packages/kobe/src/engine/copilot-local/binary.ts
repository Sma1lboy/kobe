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
  platform(): NodeJS.Platform
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
  platform() {
    return process.platform
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

  const names = deps.platform() === "win32" ? ["copilot.exe", "copilot.cmd", "copilot"] : ["copilot"]

  const tryDir = (dir: string | undefined): string | undefined => {
    if (!dir) return undefined
    for (const name of names) {
      const candidate = tryPath(path.join(dir, name))
      if (candidate) return candidate
    }
    return undefined
  }

  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]) {
    const candidate = tryDir(dir)
    if (candidate) return candidate
  }

  const nvmBin = deps.env("NVM_BIN")
  const nvmCandidate = tryDir(nvmBin)
  if (nvmCandidate) return nvmCandidate

  const home = deps.home()
  const homeDirs = [
    path.join(home, ".npm-global/bin"),
    path.join(home, ".local/bin"),
    path.join(home, ".bun/bin"),
    path.join(home, "bin"),
  ]
  if (deps.platform() === "win32") {
    const appData = deps.env("APPDATA")
    const localAppData = deps.env("LOCALAPPDATA")
    homeDirs.unshift(path.join(home, "AppData/Roaming/npm"))
    if (appData) homeDirs.unshift(path.join(appData, "npm"))
    if (localAppData) homeDirs.unshift(path.join(localAppData, "npm"))
  }

  for (const dir of homeDirs) {
    const candidate = tryDir(dir)
    if (candidate) return candidate
  }

  throw new CopilotBinaryNotFoundError(checked)
}
