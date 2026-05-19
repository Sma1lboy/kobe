/**
 * `kobe skill install/uninstall` — DEPRECATED as of v0.6.
 *
 * Skill distribution moved to the Vercel Labs agent-skills CLI:
 *
 *     npx skills add Sma1lboy/kobe --skill kobe --agent claude-code
 *
 * The SKILL.md source lives at `.agents/skills/kobe/SKILL.md` in the
 * GitHub repo (one of the directories `npx skills` scans by default),
 * and the agent-skills CLI fetches it directly. The npm tarball no
 * longer ships SKILL.md, so `kobe skill install` cannot install in a
 * published environment — it now prints the migration command and
 * exits.
 *
 * `kobe skill uninstall` is kept working since it only deletes a file
 * from `~/.claude/skills/kobe/`; no source needed. Users coming from
 * 0.5.x can still clean up.
 *
 * `probeInstalledSkill()` is preserved for `kobe diagnose`.
 */

import { existsSync } from "node:fs"
import { stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const SKILL_REL_PATH = ".claude/skills/kobe/SKILL.md"
const NPX_HINT = "npx skills add Sma1lboy/kobe --skill kobe --agent claude-code"

function resolveInstallTarget(): string {
  const home = process.env.HOME ?? homedir()
  return join(home, SKILL_REL_PATH)
}

async function runInstall(): Promise<void> {
  console.error(
    `kobe skill install is deprecated as of v0.6.\n` +
      `The skill is now distributed via the Vercel Labs agent-skills CLI:\n` +
      `\n  ${NPX_HINT}\n\n` +
      `See https://github.com/vercel-labs/skills for the install tool.`,
  )
  process.exit(2)
}

async function runUninstall(): Promise<void> {
  const target = resolveInstallTarget()
  try {
    await stat(target)
  } catch {
    console.log(`kobe skill: nothing to remove at ${target}`)
    return
  }
  await unlink(target)
  console.log(`kobe skill: removed ${target}`)
}

export async function runSkillSubcommand(argv: readonly string[]): Promise<void> {
  const [command] = argv
  if (command === "install") {
    await runInstall()
    return
  }
  if (command === "uninstall" || command === "remove") {
    await runUninstall()
    return
  }
  console.error("usage: kobe skill <install|uninstall>")
  process.exit(2)
}

/**
 * Read-only probe for `kobe diagnose`. Returns the installed path if the
 * SKILL.md exists at the canonical target location, or null otherwise.
 */
export function probeInstalledSkill(): { path: string; installed: boolean } {
  const target = resolveInstallTarget()
  return { path: target, installed: existsSync(target) }
}
