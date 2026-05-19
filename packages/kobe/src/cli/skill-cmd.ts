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

import { spawn } from "node:child_process"
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

/**
 * First-run helper: if no SKILL.md exists at the canonical target
 * (`~/.claude/skills/kobe/SKILL.md`), shell out to
 *
 *     npx --yes skills add Sma1lboy/kobe --skill kobe --agent claude-code
 *
 * so users don't have to remember the command after `npm i -g
 * @sma1lboy/kobe`. Invoked from the TUI launch path before Solid mounts.
 *
 * Design choices:
 *  - **Never clobber.** If the target file exists with any content
 *    (user-customized, older bundled version, etc.) we leave it alone.
 *    Explicit `npx skills add --force` / manual editing is the user's
 *    call; first-run auto-install is opt-in only when the file is
 *    absent.
 *  - **Inherit stdio.** A first launch already incurs the npx
 *    download/cache step; showing the user the actual progress is
 *    less surprising than a silent ~10s hang.
 *  - **Fire-and-fail-silently.** If `npx` is missing on PATH or the
 *    fetch fails (offline, GitHub rate-limit), proceed to the TUI.
 *    `kobe diagnose` will surface "skill: installed: no" so the user
 *    can re-run the command manually.
 *  - **Escape hatch.** `KOBE_NO_SKILL_AUTOINSTALL=1` skips the probe
 *    entirely — useful in CI, sandboxes, or for users who deliberately
 *    don't want kobe touching `~/.claude/skills/`.
 */
export async function ensureSkillInstalled(): Promise<void> {
  if (process.env.KOBE_NO_SKILL_AUTOINSTALL === "1") return
  const target = resolveInstallTarget()
  if (existsSync(target)) return

  console.error(
    "kobe: first-run setup — installing skill via `npx skills add`. " +
      "Press Ctrl+C to skip (set KOBE_NO_SKILL_AUTOINSTALL=1 to opt out long-term).",
  )

  await new Promise<void>((resolve) => {
    const proc = spawn(
      "npx",
      ["--yes", "skills", "add", "Sma1lboy/kobe", "--skill", "kobe", "--agent", "claude-code"],
      { stdio: "inherit" },
    )
    // Any failure mode — npx missing, fetch fails, non-zero exit — falls
    // through. The user can re-run the command manually; we don't block
    // TUI startup over it.
    proc.on("error", () => resolve())
    proc.on("exit", () => resolve())
  })
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
