/**
 * `bun e2e/hero-fixture.ts [--fresh]` — build the README capture fixture:
 * an isolated Rove home, a realistic repo with history, and the sidebar's
 * idle tasks. Real engine sessions are started separately by `hero-seed.ts`
 * so a re-shoot can reuse the transcripts it already paid for.
 *
 * Nothing here touches the operator's `~/.kobe`; see `hero-env.ts` for why
 * `HOME` is the one thing deliberately left alone.
 */

import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { HERO_CLI, HERO_CONFIG, HERO_HOME, HERO_REPO, HERO_ROOT, KOBE_DIR, heroEnv } from "./hero-env.ts"
import { HERO_COMMITS, HERO_FILES } from "./hero-repo.ts"

const env = heroEnv()

export function heroRun(command: string, args: readonly string[], cwd: string = HERO_REPO): string {
  return execFileSync(command, [...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

/** One `rove api` call through the BUILT cli, so prompt codas read `rove api …`. */
export function heroApi(args: readonly string[]): Record<string, unknown> {
  const out = heroRun("bun", [HERO_CLI, "api", ...args])
  return JSON.parse(out) as Record<string, unknown>
}

/**
 * Engine command for the capture. `acceptEdits` alone is not enough: the demo
 * prompts end in a commit and one of them asks for test coverage, and a bare
 * Bash call stops on an approval nobody is there to answer — the turn never
 * finishes and the branch stays empty. Allowing exactly the two commands the
 * storyboard needs is the narrow fix; never `bypassPermissions`, which would
 * hand an unattended agent the operator's real HOME.
 */
const CLAUDE_COMMAND = 'claude --permission-mode acceptEdits --allowedTools "Bash(git *)" "Bash(bun test*)"'

async function seedSettings(): Promise<void> {
  const pkg = JSON.parse(await readFile(join(KOBE_DIR, "package.json"), "utf8")) as { version: string }
  const state: Record<string, unknown> = {
    "app.lastRunVersion": pkg.version,
    onboarded: true,
    skillHintSeen: "1",
    savedRepos: [HERO_REPO],
    defaultVendor: "claude",
    "engineCommand.claude": CLAUDE_COMMAND,
  }
  const dir = join(HERO_CONFIG, "kobe")
  await mkdir(HERO_HOME, { recursive: true })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`)
}

async function seedRepo(): Promise<void> {
  await mkdir(HERO_REPO, { recursive: true })
  heroRun("git", ["init", "-q", "-b", "main"])
  heroRun("git", ["config", "user.email", "dev@orbit.local"])
  heroRun("git", ["config", "user.name", "Orbit"])
  const bodies = new Map(HERO_FILES.map((file) => [file.path, file.body]))
  for (const commit of HERO_COMMITS) {
    for (const path of commit.paths) {
      const body = bodies.get(path)
      if (body === undefined) throw new Error(`hero commit references unknown file: ${path}`)
      await mkdir(dirname(join(HERO_REPO, path)), { recursive: true })
      await writeFile(join(HERO_REPO, path), body)
    }
    heroRun("git", ["add", ...commit.paths])
    heroRun("git", ["commit", "-q", "-m", commit.message])
  }
}

/** Sidebar depth: real rows that cost no engine quota. */
const IDLE_TASKS = ["Port the docs snippets to the new client", "Audit token refresh under clock skew"] as const

/**
 * Routines for the automations still. Schedules sit in the small hours so a
 * capture session never trips one — an enabled routine really does fire, and
 * a firing spends a real turn.
 */
const ROUTINES: readonly { readonly name: string; readonly schedule: string; readonly prompt: string; readonly precheck?: string; readonly disabled?: boolean }[] = [
  {
    name: "Nightly dependency audit",
    schedule: "0 3 * * *",
    prompt: "Audit dependencies for advisories and open a branch with the safe upgrades.",
    precheck: "git log --since=24.hours -1 --oneline | grep .",
  },
  {
    name: "Weekly flaky-test hunt",
    schedule: "0 4 * * MON",
    prompt: "Run the suite ten times, find any test that is not deterministic, and fix it.",
  },
  {
    name: "Release notes draft",
    schedule: "0 5 * * FRI",
    prompt: "Draft release notes from this week's merged commits.",
    disabled: true,
  },
]

function seedRoutines(): void {
  for (const routine of ROUTINES) {
    const args = [
      "routine-create",
      "--repo",
      HERO_REPO,
      "--name",
      routine.name,
      "--schedule",
      routine.schedule,
      "--prompt",
      routine.prompt,
    ]
    if (routine.precheck) args.push("--precheck", routine.precheck)
    if (routine.disabled) args.push("--disabled")
    heroApi(args)
  }
}

async function main(): Promise<void> {
  const fresh = process.argv.includes("--fresh")
  if (fresh || !existsSync(HERO_REPO)) {
    if (existsSync(HERO_HOME)) {
      try {
        heroRun("bun", [HERO_CLI, "daemon", "stop"], KOBE_DIR)
      } catch {
        // no daemon to stop
      }
    }
    await rm(HERO_ROOT, { recursive: true, force: true })
    await mkdir(HERO_HOME, { recursive: true })
    await seedSettings()
    await seedRepo()
    for (const title of IDLE_TASKS) heroApi(["add", "--repo", HERO_REPO, "--title", title])
    seedRoutines()
  }
  const listed = heroApi(["list"]) as { tasks?: unknown[] }
  console.log(`[hero] home ${HERO_HOME}`)
  console.log(`[hero] repo ${HERO_REPO} · ${listed.tasks?.length ?? 0} task(s)`)
}

if (import.meta.main) await main()
