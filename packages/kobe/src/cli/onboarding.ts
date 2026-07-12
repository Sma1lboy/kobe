/**
 * First-run onboarding — the framework-free half.
 *
 * A bare `kobe` on a TTY runs the inline wizard once
 * (`src/tui-react/onboarding/host.tsx` collects the answers), then this
 * module APPLIES them after the renderer is torn down: hook shell
 * completions into the user's rc file, optionally run the agent-skill
 * installer (npx, inherits the terminal), print the ready banner, and
 * persist the `onboarded` flag so it never runs again. Every install is
 * re-runnable later (`kobe completions --help`, `kobe skill install`), so
 * declining is always safe.
 */

import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { npxSkillsArgv, npxSkillsCommand } from "../lib/skill-install.ts"
import { getPersistedBool, setPersistedBool } from "../state/store.ts"
import { t } from "../tui/i18n"

const ONBOARDED_KEY = "onboarded"

export type ShellKind = "zsh" | "bash" | "fish"

/** The wizard's answers; a skipped wizard (q/esc) declines everything. */
export interface OnboardingChoices {
  readonly completions: boolean
  readonly skill: boolean
}

/** Detect the user's shell from $SHELL; null = unknown (step is skipped). */
export function detectShell(env: NodeJS.ProcessEnv = process.env): ShellKind | null {
  const shell = basename(env.SHELL ?? "")
  return shell === "zsh" || shell === "bash" || shell === "fish" ? shell : null
}

/** Marker that makes the rc-append idempotent across re-runs. */
const RC_MARKER = "kobe completions"

/**
 * Hook completions into the shell, returning the file that was touched.
 * zsh/bash get one guarded `source <(kobe completions <shell>)` line in
 * their rc file (the generated zsh script self-registers via compdef when
 * sourced); fish gets a lazy one-liner completions file, which fish
 * autoloads with no rc edit. All three re-generate from the live binary,
 * so completions never go stale across updates.
 */
export function installCompletions(shell: ShellKind, home: string = homedir()): string {
  if (shell === "fish") {
    const dir = join(home, ".config", "fish", "completions")
    const path = join(dir, "kobe.fish")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, "kobe completions fish | source\n")
    return path
  }
  const rc = join(home, shell === "zsh" ? ".zshrc" : ".bashrc")
  const existing = existsSync(rc) ? readFileSync(rc, "utf8") : ""
  if (!existing.includes(RC_MARKER)) {
    const line = `\n# kobe completions\ncommand -v kobe >/dev/null && source <(kobe completions ${shell})\n`
    appendFileSync(rc, line)
  }
  return rc
}

export function isOnboarded(): boolean {
  return getPersistedBool(ONBOARDED_KEY, false)
}

export function markOnboarded(): void {
  setPersistedBool(ONBOARDED_KEY, true)
}

/**
 * Apply the wizard's answers and print the ready banner. Runs AFTER the
 * inline renderer is destroyed — the skill installer inherits the real
 * terminal (npx prompts/progress), and the summary lands in scrollback.
 */
export function applyOnboardingChoices(choices: OnboardingChoices, shell: ShellKind | null): void {
  const out = (line: string) => process.stdout.write(`${line}\n`)
  if (shell !== null) {
    if (choices.completions) {
      out(t("onboarding.appliedCompletions", { path: installCompletions(shell) }))
    } else {
      out(t("onboarding.skippedCompletions", { command: "kobe completions --help" }))
    }
  }
  if (choices.skill) {
    out(t("onboarding.installingSkill", { command: npxSkillsCommand() }))
    const result = spawnSync("npx", npxSkillsArgv(), { stdio: "inherit" })
    if (result.status !== 0) out(t("onboarding.skillFailed", { command: "kobe skill install" }))
  } else {
    out(t("onboarding.skippedSkill", { command: "kobe skill install" }))
  }
  out("")
  out(t("onboarding.ready"))
  out(t("onboarding.readyHint"))
}

/**
 * The bare-`kobe` gate: on a first interactive launch, run the wizard and
 * return true (the caller exits instead of starting the TUI — the wizard
 * ends with "run `kobe`" so the next launch lands in the app). Returns
 * false when onboarding already happened or there's no TTY to ask on.
 */
export async function maybeRunOnboarding(): Promise<boolean> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) return false
  if (isOnboarded()) return false
  // Mark BEFORE the wizard even shows: a killed/EOF'd/crashed wizard (or a
  // failed npx afterwards) must never re-trigger it — one showing, ever,
  // same never-nag rule as maybeHintSkillInstall.
  markOnboarded()
  const shell = detectShell()
  const { runOnboardingWizard } = await import("../tui-react/onboarding/host.tsx")
  const choices = await runOnboardingWizard(shell)
  applyOnboardingChoices(choices, shell)
  return true
}
