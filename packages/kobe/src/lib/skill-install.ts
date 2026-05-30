/**
 * Detect whether the kobe agent skill is installed, and nudge the user to
 * install it once if not.
 *
 * The skill (`.agents/skills/kobe/SKILL.md` in this repo) teaches an agent
 * — Claude Code by default — when and how to drive `kobe api` (fan out
 * parallel tasks from a shell). It is installed separately, via the Vercel
 * Labs agent-skills CLI, into the agent's skill directory. kobe itself
 * does not need it; this is purely an onboarding aid so a user who also
 * runs Claude Code knows the capability exists.
 *
 * Reliable check: `kobe doctor`. The startup hint here is best-effort —
 * the tmux/opentui screen takeover can scroll it off — so it fires at most
 * once (gated on a persisted flag) and never nags.
 */

import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { getPersistedString, setPersistedString } from "../state/repos.ts"

/**
 * Where the kobe skill lands for Claude Code, relative to a home/project
 * root. This is the OS home's `~/.claude`, NOT kobe's `KOBE_HOME_DIR` —
 * Claude Code installs skills under the real user home regardless of
 * kobe's own state-dir override.
 */
const SKILL_REL_PATH = ".claude/skills/kobe/SKILL.md"

/** The `npx skills` command that installs the kobe skill for Claude Code. */
export const SKILL_INSTALL_COMMAND = "npx skills add Sma1lboy/kobe --skill kobe --agent claude-code"

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
    `\nkobe: the kobe agent skill isn't installed — install it so Claude Code can fan out parallel tasks via \`kobe api\`:\n  ${SKILL_INSTALL_COMMAND}\n  (check anytime with \`kobe doctor\`)\n\n`,
  )
}
