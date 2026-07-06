import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { getPersistedString, setPersistedString } from "../state/repos.ts"

export const KOBE_SKILL_VERSION = 2

const SKILL_REL_PATH = ".claude/skills/kobe/SKILL.md"

export const SKILL_INSTALL_COMMAND = "kobe skill install"

export const SKILL_SOURCE_SLUG = "Sma1lboy/kobe"

export const DEFAULT_SKILL_AGENT = "claude-code"

export function npxSkillsArgv(opts: { agent?: string } = {}): string[] {
  return ["skills", "add", SKILL_SOURCE_SLUG, "--skill", "kobe", "--agent", opts.agent ?? DEFAULT_SKILL_AGENT]
}

export function npxSkillsCommand(opts: { agent?: string } = {}): string {
  return `npx ${npxSkillsArgv(opts).join(" ")}`
}

const HINT_SEEN_KEY = "skillHintSeen"

export function kobeSkillPaths(opts: { home?: string; cwd?: string } = {}): string[] {
  const home = opts.home ?? homedir()
  const cwd = opts.cwd ?? process.cwd()
  return [join(home, SKILL_REL_PATH), join(cwd, SKILL_REL_PATH)]
}

export function isKobeSkillInstalled(opts?: { home?: string; cwd?: string }): boolean {
  return kobeSkillPaths(opts).some((p) => existsSync(p))
}

export function parseSkillVersion(content: string): number | null {
  const m = content.match(/kobe-skill-version:\s*(\d+)/)
  return m ? Number.parseInt(m[1], 10) : null
}

export interface SkillState {
  readonly installed: boolean
  readonly installedVersion: number | null
  readonly currentVersion: number
  readonly stale: boolean
}

export function kobeSkillState(opts?: { home?: string; cwd?: string }): SkillState {
  const path = kobeSkillPaths(opts).find((p) => existsSync(p))
  if (!path) {
    return { installed: false, installedVersion: null, currentVersion: KOBE_SKILL_VERSION, stale: false }
  }
  let installedVersion: number | null = null
  try {
    installedVersion = parseSkillVersion(readFileSync(path, "utf8"))
  } catch {
    installedVersion = null
  }
  const stale = installedVersion === null || installedVersion < KOBE_SKILL_VERSION
  return { installed: true, installedVersion, currentVersion: KOBE_SKILL_VERSION, stale }
}

export function maybeHintSkillInstall(): void {
  const state = kobeSkillState()
  if (!state.installed) {
    if (getPersistedString(HINT_SEEN_KEY) === "1") return
    setPersistedString(HINT_SEEN_KEY, "1")
    process.stderr.write(
      `\nkobe: the kobe agent skill isn't installed — install it so your coding agent can drive kobe via \`kobe api\`:\n  ${SKILL_INSTALL_COMMAND}\n  (wraps \`${npxSkillsCommand()}\`; check anytime with \`kobe doctor\`)\n\n`,
    )
    return
  }
  if (state.stale) {
    const key = `${HINT_SEEN_KEY}:v${state.currentVersion}`
    if (getPersistedString(key) === "1") return
    setPersistedString(key, "1")
    const was = state.installedVersion === null ? "an older" : `v${state.installedVersion}`
    process.stderr.write(
      `\nkobe: your kobe agent skill is out of date (${was}; this kobe wants v${state.currentVersion}) — refresh it so \`kobe api\` guidance matches:\n  ${SKILL_INSTALL_COMMAND}\n\n`,
    )
  }
}
