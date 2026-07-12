/**
 * Install + detect the kobe agent skill.
 *
 * The skill teaches a coding agent when and how to drive `kobe api` (the
 * full task-lifecycle CLI). It is distributed via the Vercel Labs
 * agent-skills CLI — `npx skills add Sma1lboy/kobe` pulls the canonical
 * `.agents/skills/kobe/SKILL.md` from the repo and installs it into the
 * agent's skill dir. `kobe skill install` is a thin CONVENIENCE WRAPPER
 * that runs exactly that flow for the developer, so nobody has to remember
 * the `npx skills add Sma1lboy/kobe --skill kobe --agent …` invocation.
 *
 * Reliable check: `kobe skill status`. The startup hint
 * here is best-effort (the opentui screen takeover can scroll it off),
 * so it fires at most once (gated on a persisted flag) and never nags.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { getPersistedString, setPersistedString } from "../state/repos.ts"

/**
 * Version of the SKILL.md guidance THIS kobe build expects. Bump it (in
 * lockstep with the `<!-- kobe-skill-version: N -->` marker in
 * `.agents/skills/kobe/SKILL.md`) whenever the skill's instructions change
 * meaningfully — e.g. the `kobe api` surface grows. An installed skill whose
 * marker is below this number is STALE: the binary moved on, the skill
 * didn't, so we prompt the developer to re-run `kobe skill install`.
 */
export const KOBE_SKILL_VERSION = 4

/**
 * Where the kobe skill lands for a coding agent, relative to a home/project
 * root. This is `.claude/skills/...`, NOT kobe's `KOBE_HOME_DIR` — agents
 * read skills from the real project/home regardless of kobe's state-dir.
 */
const SKILL_REL_PATH = ".claude/skills/kobe/SKILL.md"

/** The kobe-side wrapper command a user runs. Shown in hints / doctor. */
export const SKILL_INSTALL_COMMAND = "kobe skill install"

/** The agent-skills CLI repo slug the wrapper installs from. */
export const SKILL_SOURCE_SLUG = "Sma1lboy/kobe"

/** Default coding agent the skill is installed for. */
export const DEFAULT_SKILL_AGENT = "claude-code"

/**
 * Build the `npx skills add …` argv that `kobe skill install` wraps. Pure +
 * testable: the wrapper spawns `npx` with these args. `agent` selects which
 * coding agent's skill dir to install into (the agent-skills CLI handles the
 * actual placement under `.claude/skills/...`).
 */
export function npxSkillsArgv(opts: { agent?: string } = {}): string[] {
  return ["skills", "add", SKILL_SOURCE_SLUG, "--skill", "kobe", "--agent", opts.agent ?? DEFAULT_SKILL_AGENT]
}

/** The full underlying command string, for display in help / hints. */
export function npxSkillsCommand(opts: { agent?: string } = {}): string {
  return `npx ${npxSkillsArgv(opts).join(" ")}`
}

/** Persisted flag: the one-time startup hint has already been shown. */
const HINT_SEEN_KEY = "skillHintSeen"

/**
 * Candidate install locations, in priority order: the user's home dir,
 * then the current project. `home`/`cwd` are injectable for tests; they
 * default to the OS home and the current working directory.
 */
export function kobeSkillPaths(opts: { home?: string; cwd?: string } = {}): string[] {
  const home = opts.home ?? homedir()
  const cwd = opts.cwd ?? process.cwd()
  return [join(home, SKILL_REL_PATH), join(cwd, SKILL_REL_PATH)]
}

/** True if the kobe agent skill is installed at the user OR project level. */
export function isKobeSkillInstalled(opts?: { home?: string; cwd?: string }): boolean {
  return kobeSkillPaths(opts).some((p) => existsSync(p))
}

/** Parse the `<!-- kobe-skill-version: N -->` marker out of a SKILL.md body. */
export function parseSkillVersion(content: string): number | null {
  const m = content.match(/kobe-skill-version:\s*(\d+)/)
  return m ? Number.parseInt(m[1], 10) : null
}

export interface SkillState {
  readonly installed: boolean
  /** Marker version of the installed skill (null if installed but unstamped). */
  readonly installedVersion: number | null
  /** What this binary expects ({@link KOBE_SKILL_VERSION}). */
  readonly currentVersion: number
  /** Installed, stamped, and behind the binary → re-install recommended. */
  readonly stale: boolean
}

/**
 * Inspect the installed skill vs the version this binary expects. An
 * UNSTAMPED installed skill (pre-versioning) is treated as stale so it gets
 * refreshed once. An absent skill is "not installed" (not stale).
 */
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

/**
 * Print a best-effort, one-time hint to stderr when the kobe skill is absent
 * OR out of date. Two independent one-shot gates:
 *   - absent → hint to install (gated on {@link HINT_SEEN_KEY}).
 *   - stale  → hint to update, gated PER skill version (`HINT_SEEN_KEY:vN`),
 *     so a fresh staleness after a kobe upgrade re-hints exactly once.
 * Safe to call on every startup.
 */
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
