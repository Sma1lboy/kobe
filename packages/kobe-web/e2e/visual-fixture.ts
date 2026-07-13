import { execFileSync } from "node:child_process"
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve, sep } from "node:path"

const REPO_ROOT = resolve(import.meta.dirname, "../../..")
export const KOBE_DIR: string = join(REPO_ROOT, "packages", "kobe")
export const VISUAL_PORT_BASE = Number.parseInt(process.env.KOBE_VISUAL_PORT_BASE ?? "5273", 10)
export const VISUAL_WEB_PORT = VISUAL_PORT_BASE
export const VISUAL_DAEMON_PORT = VISUAL_PORT_BASE + 1
export const VISUAL_PTY_PORT = VISUAL_PORT_BASE + 2
export const VISUAL_RUN_ID = `p${VISUAL_PORT_BASE}`
export const VISUAL_ROOT = join(REPO_ROOT, ".scratch", `opentui-visual-${VISUAL_PORT_BASE}`)
export const VISUAL_HOME = join(VISUAL_ROOT, "home")
export const VISUAL_REPO = join(VISUAL_ROOT, "fixture-repo")

/** Bump when the fixture shape changes so warm reuse rebuilds. */
const FIXTURE_VERSION = "1"
const FIXTURE_MARKER = join(VISUAL_ROOT, "fixture-ok")

// Inlined into the PTY command: the child runs under `/bin/sh -lc`, and a
// login shell or env-passing gap must NEVER let it fall back to the shared
// `.dev-sandbox/home` (the owner's live environment).
export const VISUAL_PTY_COMMAND = `HOME=${VISUAL_HOME} KOBE_SANDBOX_HOME_DIR=${VISUAL_HOME} KOBE_HOME_DIR=${VISUAL_HOME} XDG_CONFIG_HOME=${VISUAL_HOME}/.config KOBE_DAEMON_WEB_PORT=${VISUAL_DAEMON_PORT} bun run dev:sandbox`

const XDG_CONFIG_HOME = join(VISUAL_HOME, ".config")
const XDG_DATA_HOME = join(VISUAL_HOME, ".local", "share")
const XDG_STATE_HOME = join(VISUAL_HOME, ".local", "state")
const XDG_CACHE_HOME = join(VISUAL_HOME, ".cache")
const XDG_RUNTIME_DIR = join(VISUAL_HOME, ".runtime")

const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      value !== undefined &&
      !key.startsWith("KOBE_") &&
      key !== "HOME" &&
      key !== "USERPROFILE" &&
      !key.startsWith("XDG_") &&
      key !== "TERM" &&
      key !== "TERM_PROGRAM" &&
      key !== "TERM_PROGRAM_VERSION" &&
      key !== "COLORTERM",
  ),
) as Record<string, string>

export const VISUAL_ENV: Record<string, string> = {
  ...inherited,
  HOME: VISUAL_HOME,
  USERPROFILE: VISUAL_HOME,
  XDG_CONFIG_HOME,
  XDG_DATA_HOME,
  XDG_STATE_HOME,
  XDG_CACHE_HOME,
  XDG_RUNTIME_DIR,
  TERM: "xterm-256color",
  COLORTERM: "truecolor",
  KOBE_HOME_DIR: VISUAL_HOME,
  KOBE_SANDBOX_HOME_DIR: VISUAL_HOME,
  KOBE_DAEMON_WEB_PORT: String(VISUAL_DAEMON_PORT),
}

function assertSafeVisualRoot(): void {
  const scratch = join(REPO_ROOT, ".scratch")
  const insideScratch = relative(scratch, VISUAL_ROOT)
  if (insideScratch.startsWith(`..${sep}`) || insideScratch === ".." || basename(VISUAL_ROOT) !== `opentui-visual-${VISUAL_PORT_BASE}`) {
    throw new Error(`refusing visual fixture cleanup outside .scratch: ${VISUAL_ROOT}`)
  }
}

function run(command: string, args: readonly string[], cwd: string = KOBE_DIR): string {
  return execFileSync(command, [...args], {
    cwd,
    env: VISUAL_ENV,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
}

function runKobe(args: readonly string[]): unknown {
  const output = run("bun", ["--conditions=browser", "./src/cli/index.ts", "api", ...args])
  return JSON.parse(output) as unknown
}

function createdIssueId(value: unknown, title: string): number {
  const issues = (value as { issues?: Array<{ id?: unknown; title?: unknown }> }).issues
  const id = issues?.find((issue) => issue.title === title)?.id
  if (typeof id !== "number") throw new Error(`visual fixture did not create issue: ${title}`)
  return id
}

async function seedStartupState(): Promise<void> {
  const packageJson = JSON.parse(await readFile(join(KOBE_DIR, "package.json"), "utf8")) as { version: string }
  const skillPath = join(REPO_ROOT, ".claude", "skills", "kobe", "SKILL.md")
  let skillVersion: string | undefined
  try {
    const skill = await readFile(skillPath, "utf8")
    skillVersion = skill.match(/kobe-skill-version:\s*(\d+)/)?.[1]
  } catch {
    skillVersion = undefined
  }

  const state: Record<string, string | boolean> = {
    "app.lastRunVersion": packageJson.version,
    onboarded: true,
    skillHintSeen: "1",
  }
  if (skillVersion) state[`skillHintSeen:v${skillVersion}`] = "1"
  const stateDir = join(XDG_CONFIG_HOME, "kobe")
  await mkdir(stateDir, { recursive: true })
  await writeFile(join(stateDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`)
}

export async function cleanupVisualFixture(): Promise<void> {
  assertSafeVisualRoot()
  // Kill the harness TUI first: globalTeardown runs BEFORE Playwright stops
  // the PTY sidecar, and a live TUI auto-restarts the daemon right after our
  // reset — leaking a detached daemon whose home we are about to delete.
  await fetch(`http://127.0.0.1:${VISUAL_PTY_PORT}/pty/close`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tab: `visual-${VISUAL_RUN_ID}` }),
  }).catch(() => {})
  await new Promise((resolve) => setTimeout(resolve, 500))
  try {
    run("bun", ["run", "dev:sandbox:reset"])
  } finally {
    // Teardown runs before Playwright stops the PTY sidecar, so the sandbox
    // TUI can still be flushing state — retry until its writers are gone.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rm(VISUAL_ROOT, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt >= 10) throw error
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
    }
  }
}

/** Warm-path probe: marker matches and the fixture daemon still answers. */
async function fixtureIsWarm(): Promise<boolean> {
  if (process.env.KOBE_VISUAL_FRESH === "1") return false
  try {
    if ((await readFile(FIXTURE_MARKER, "utf8")).trim() !== FIXTURE_VERSION) return false
    // `kobe api list` auto-starts the fixture daemon when it idled out.
    const listed = runKobe(["list"]) as { tasks?: Array<{ title?: unknown }> }
    return listed.tasks?.some((task) => task.title === "Visual Fixture") ?? false
  } catch {
    return false
  }
}

export default async function setupVisualFixture(): Promise<void> {
  if (await fixtureIsWarm()) return
  await cleanupVisualFixture()
  await Promise.all(
    [VISUAL_HOME, VISUAL_REPO, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, XDG_RUNTIME_DIR].map(
      (dir) => mkdir(dir, { recursive: true }),
    ),
  )
  await chmod(XDG_RUNTIME_DIR, 0o700)
  await seedStartupState()

  run("git", ["init", "-q"], VISUAL_REPO)
  run("git", ["config", "user.email", "visual@kobe.local"], VISUAL_REPO)
  run("git", ["config", "user.name", "kobe visual"], VISUAL_REPO)
  await writeFile(join(VISUAL_REPO, "README.md"), "# OpenTUI visual fixture\n")
  run("git", ["add", "README.md"], VISUAL_REPO)
  run("git", ["commit", "-q", "-m", "fixture"], VISUAL_REPO)

  const added = runKobe([
    "add",
    "--repo",
    VISUAL_REPO,
    "--title",
    "Visual Fixture",
    "--vendor",
    "claude",
    "--activate",
  ]) as { taskId?: unknown }
  if (typeof added.taskId !== "string") throw new Error("visual fixture task creation returned no taskId")

  const backlogTitle = "Backlog fixture"
  const progressTitle = "In progress fixture"
  const doneTitle = "Done fixture"
  createdIssueId(
    runKobe(["issue-create", "--repo", VISUAL_REPO, "--title", backlogTitle, "--body", "Waiting to start."]),
    backlogTitle,
  )
  const progressId = createdIssueId(
    runKobe(["issue-create", "--repo", VISUAL_REPO, "--title", progressTitle, "--body", "Work is active."]),
    progressTitle,
  )
  runKobe(["issue-update", "--repo", VISUAL_REPO, "--id", String(progressId), "--task", added.taskId])
  const doneId = createdIssueId(
    runKobe(["issue-create", "--repo", VISUAL_REPO, "--title", doneTitle, "--body", "Work is complete."]),
    doneTitle,
  )
  runKobe(["issue-set-status", "--repo", VISUAL_REPO, "--id", String(doneId), "--status", "done"])
  runKobe(["set-active", "--task-id", added.taskId])
  await writeFile(FIXTURE_MARKER, `${FIXTURE_VERSION}\n`)
}
