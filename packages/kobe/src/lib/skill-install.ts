/**
 * Install + detect the kobe agent skill.
 *
 * The skill teaches a coding agent when and how to drive `kobe api` (the
 * full task-lifecycle CLI). Installation runs through the Vercel Labs
 * agent-skills CLI (`npx skills add`), which owns the part that is genuinely
 * hard to maintain: the registry of ~75 coding agents, where each one reads
 * its skills from, which get a real directory vs a symlink into the shared
 * `.agents/skills`. kobe does NOT reimplement any of that.
 *
 * What kobe changes is the SOURCE. `npx skills add Sma1lboy/kobe` clones the
 * repo (`git clone --depth 1`) — 198MB of working tree to deliver an 8KB
 * SKILL.md, which is effectively un-installable on a slow connection. But a
 * user running `kobe skill install` already HAS kobe, and the skill ships
 * inside the npm package, so the CLI is pointed at that local copy instead:
 * {@link bundledSkillDir}. No clone, no network. The published repo slug
 * stays available as {@link SKILL_SOURCE_SLUG} for people without kobe.
 *
 * Reliable check: `kobe skill status`. The startup hint
 * here is best-effort (the opentui screen takeover can scroll it off).
 * Absent skill → one-shot hint, never nags. Stale skill on an interactive
 * terminal → a yes / no / don't-notify-this-version prompt (runs before the
 * screen takeover); "no" re-asks next launch, "don't notify" mutes that
 * skill version, non-TTY falls back to the old one-shot hint.
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { getPersistedString, setPersistedString } from "../state/repos.ts"

/**
 * Version of the SKILL.md guidance THIS kobe build expects. Bump it (in
 * lockstep with the `<!-- kobe-skill-version: N -->` marker in
 * `.agents/skills/kobe/SKILL.md`) whenever the skill's instructions change
 * meaningfully — e.g. the `kobe api` surface grows. An installed skill whose
 * marker is below this number is STALE: the binary moved on, the skill
 * didn't, so we prompt the developer to re-run `kobe skill install`.
 */
export const KOBE_SKILL_VERSION = 9

/**
 * Where an installed kobe skill can be FOUND, relative to a home/project
 * root. Not kobe's `KOBE_HOME_DIR` — agents read skills from the real
 * project/home regardless of kobe's state-dir.
 *
 * Two locations because the agent-skills CLI writes the real file into the
 * shared `.agents/skills` and SYMLINKS agent-specific dirs at it (that's its
 * default; `--copy` opts out). `existsSync` follows symlinks, so either path
 * answering is a genuine install. `.claude` stays in the list so skills
 * installed by older kobe versions still register as present.
 */
const SKILL_REL_PATHS = [".agents/skills/kobe/SKILL.md", ".claude/skills/kobe/SKILL.md"] as const

/** The kobe-side wrapper command a user runs. Shown in hints / doctor. */
export const SKILL_INSTALL_COMMAND = "kobe skill install"

/**
 * The public repo slug. Only a FALLBACK now (and the documented route for
 * people who don't have kobe installed): resolving it means a 198MB clone.
 */
export const SKILL_SOURCE_SLUG = "Sma1lboy/kobe"

/**
 * The skill directory shipped inside this install, or null in an environment
 * where it isn't present (an unbuilt source checkout). Candidates mirror
 * `web-cmd.ts`'s dist-asset lookup: repo layout first, then the packaged
 * copy the build emits into `dist/skills`.
 */
export function bundledSkillDir(): string | null {
  const here = fileURLToPath(import.meta.url)
  const candidates = [
    resolve(here, "../../../../../.agents/skills/kobe"), // dev: repo root .agents/skills/kobe
    resolve(here, "../../skills/kobe"), // packaged: dist/skills/kobe
  ]
  return candidates.find((dir) => existsSync(join(dir, "SKILL.md"))) ?? null
}

/**
 * Build the `npx skills add …` argv. `source` is the bundled directory when
 * we have one (a local path — the CLI validates it and skips the network
 * entirely) and the repo slug otherwise.
 *
 * Agent SELECTION is deliberately left to the agent-skills CLI: omitting
 * `--agent` makes it detect the installed agents and prompt, which is the
 * one part of this we never want to reimplement — that registry covers ~75
 * agents and changes constantly. Pass `agent` only when the user asked for
 * a specific one. Note the CLI wants a repeated flag per agent, not a
 * comma-joined list (it rejects `--agent claude-code,codex`).
 */
export function npxSkillsArgv(opts: { agent?: string | readonly string[]; source?: string | null } = {}): string[] {
  const source = opts.source !== undefined ? opts.source : bundledSkillDir()
  const agents = opts.agent === undefined ? [] : typeof opts.agent === "string" ? [opts.agent] : opts.agent
  return ["skills", "add", source ?? SKILL_SOURCE_SLUG, "--skill", "kobe", ...agents.flatMap((a) => ["--agent", a])]
}

/** The full underlying command string, for display in help / hints. */
export function npxSkillsCommand(opts: { agent?: string | readonly string[]; source?: string | null } = {}): string {
  return `npx ${npxSkillsArgv(opts).join(" ")}`
}

/**
 * Run the `npx skills add …` install flow, inheriting stdio (so the CLI's
 * own agent picker is fully interactive). Returns the npx exit code.
 */
export async function runNpxSkillsInstall(agent?: string | readonly string[]): Promise<number> {
  const proc = Bun.spawn(["npx", ...npxSkillsArgv(agent === undefined ? {} : { agent })], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return await proc.exited
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
  return [home, cwd].flatMap((root) => SKILL_REL_PATHS.map((rel) => join(root, rel)))
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

/** Test seams for the startup prompt (presence of `ask` marks the session interactive). */
export interface SkillHintIO {
  /** Read one line of user input. */
  ask?: () => Promise<string>
  /** Run the install flow; returns the exit code. */
  install?: () => Promise<number>
}

/** Read one line from stdin (cooked mode — runs before any screen takeover). */
function promptLine(): Promise<string> {
  return new Promise((resolve) => {
    process.stdin.resume()
    process.stdin.once("data", (d) => {
      process.stdin.pause()
      resolve(String(d))
    })
  })
}

/**
 * Best-effort startup notice when the kobe skill is absent or out of date.
 *   - absent → one-time hint to install (gated on {@link HINT_SEEN_KEY}).
 *   - stale + interactive terminal → prompt: yes (install now) / no (ask
 *     again next launch) / don't notify for this version (persists
 *     `HINT_SEEN_KEY:vN`, so the next skill-version bump prompts again).
 *   - stale + non-TTY → the old one-shot stderr hint, gated per version.
 * Safe to call on every startup.
 */
export async function maybeHintSkillInstall(io: SkillHintIO = {}): Promise<void> {
  const state = kobeSkillState()
  if (!state.installed) {
    if (getPersistedString(HINT_SEEN_KEY) === "1") return
    setPersistedString(HINT_SEEN_KEY, "1")
    process.stderr.write(
      `\nkobe: the kobe agent skill isn't installed — install it so your coding agent can drive kobe via \`kobe api\`:\n  ${SKILL_INSTALL_COMMAND}\n  (wraps \`${npxSkillsCommand()}\`; check anytime with \`kobe doctor\`)\n\n`,
    )
    return
  }
  if (!state.stale) return

  const key = `${HINT_SEEN_KEY}:v${state.currentVersion}`
  if (getPersistedString(key) === "1") return
  const was = state.installedVersion === null ? "an older version" : `v${state.installedVersion}`

  const interactive = io.ask !== undefined || Boolean(process.stdin.isTTY && process.stderr.isTTY)
  if (!interactive) {
    setPersistedString(key, "1")
    process.stderr.write(
      `\nkobe: your kobe agent skill is out of date (${was}; this kobe wants v${state.currentVersion}) — refresh it so \`kobe api\` guidance matches:\n  ${SKILL_INSTALL_COMMAND}\n\n`,
    )
    return
  }

  process.stderr.write(
    `\nkobe: a new version of the kobe agent skill is available (${was} → v${state.currentVersion}).\nUpdate now? [y]es / [n]o / [d]on't notify for this version: `,
  )
  const answer = (await (io.ask ?? promptLine)()).trim().toLowerCase()
  if (answer === "y" || answer === "yes") {
    const code = await (io.install ?? runNpxSkillsInstall)()
    if (code === 0) process.stderr.write("kobe: skill updated.\n")
    else process.stderr.write(`kobe: skill update failed (exit ${code}) — run \`${SKILL_INSTALL_COMMAND}\` manually.\n`)
  } else if (answer.startsWith("d")) {
    setPersistedString(key, "1")
  }
  // anything else = "no": ask again next launch, nothing persisted.
}
