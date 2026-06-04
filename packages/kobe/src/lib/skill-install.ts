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
 * Reliable check: `kobe doctor` / `kobe skill status`. The startup hint
 * here is best-effort (the tmux/opentui screen takeover can scroll it off),
 * so it fires at most once (gated on a persisted flag) and never nags.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { getPersistedString, setPersistedString } from "../state/repos.ts"

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

/**
 * Print a one-time install hint to stderr when the skill is absent. No-op
 * if the skill is installed or the hint was already shown once. Safe to
 * call on every startup; it persists a flag so it never repeats.
 */
export function maybeHintSkillInstall(): void {
  if (isKobeSkillInstalled()) return
  if (getPersistedString(HINT_SEEN_KEY) === "1") return
  setPersistedString(HINT_SEEN_KEY, "1")
  process.stderr.write(
    `\nkobe: the kobe agent skill isn't installed — install it so your coding agent can drive kobe via \`kobe api\`:\n  ${SKILL_INSTALL_COMMAND}\n  (wraps \`${npxSkillsCommand()}\`; check anytime with \`kobe doctor\`)\n\n`,
  )
}
