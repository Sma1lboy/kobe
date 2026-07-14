import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { runReplayCapture, writeCaptureAtomically, type CaptureOutput } from "../src/quicklook/capture-core"
import {
  createPureTuiCapture,
  type PureTuiCaptureOptions,
} from "../src/quicklook/puretui-terminal"
import { resolveReplaySpec, type CaptureMeta, type RawReplaySpec } from "../src/quicklook/replay-spec"

const PACKAGE_ROOT = resolve(import.meta.dirname, "..")
const REPO_ROOT = resolve(PACKAGE_ROOT, "../..")
const DEFAULT_SPEC = join(PACKAGE_ROOT, "src", "quicklook", "quicklook.replay.json")
const DEFAULT_OUTPUT = join(PACKAGE_ROOT, "src", "quicklook", "frames.json")

type CaptureHandle = Awaited<ReturnType<typeof createPureTuiCapture>>

export type CapturePureTuiOptions = {
  specPath: string
  outputPath: string
  demoRoot: string
  keepDemoRoot: boolean
  timeoutMs?: number
}

type CaptureDependencies = {
  createCapture?: (options: PureTuiCaptureOptions) => Promise<CaptureHandle>
  log?: (line: string) => void
}

const plannedCapture = (raw: unknown): CaptureMeta => {
  const candidate = raw as Partial<RawReplaySpec>
  const cols = typeof candidate.viewport?.cols === "number" ? candidate.viewport.cols : -1
  const rows = typeof candidate.viewport?.rows === "number" ? candidate.viewport.rows : -1
  const captureEnd = typeof candidate.capture?.seconds === "number" ? candidate.capture.seconds : 0
  return { cols, rows, frames: [{ t: captureEnd, lines: [] }] }
}

const run = async (file: string, args: readonly string[], cwd: string) => {
  const child = Bun.spawn([file, ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`${file} ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`)
  return stdout.trim()
}

const createFixtureRepository = async (demoRoot: string): Promise<string> => {
  const fixtureRepo = join(demoRoot, "fixture-repo")
  await mkdir(fixtureRepo, { recursive: true })
  await run("git", ["init", "-q", "-b", "main"], fixtureRepo)
  await run("git", ["config", "user.email", "capture@kobe.local"], fixtureRepo)
  await run("git", ["config", "user.name", "kobe capture"], fixtureRepo)
  await writeFile(join(fixtureRepo, "README.md"), "# PureTUI replay fixture\n")
  await run("git", ["add", "README.md"], fixtureRepo)
  await run("git", ["commit", "-q", "-m", "fixture"], fixtureRepo)
  return fixtureRepo
}

const prepareCaptureState = async (demoRoot: string, fixtureRepo: string): Promise<void> => {
  const configDir = join(demoRoot, "home", ".config", "kobe")
  await mkdir(configDir, { recursive: true })
  await writeFile(
    join(configDir, "state.json"),
    `${JSON.stringify({ onboarded: true, skillHintSeen: "1", savedRepos: [fixtureRepo] }, null, 2)}\n`,
  )
}

const captureOutput = (outputPath: string): CaptureOutput => ({
  replaceAtomically: (capture) => writeCaptureAtomically(outputPath, capture),
})

export async function capturePureTui(
  options: CapturePureTuiOptions,
  dependencies: CaptureDependencies = {},
): Promise<{ outputPath: string; demoRoot: string }> {
  const raw = JSON.parse(await readFile(options.specPath, "utf8")) as unknown
  // Validation is deliberately before fixture creation and sidecar spawn. A bad
  // checked-in replay must have no process or filesystem side effects.
  const spec = resolveReplaySpec(raw, plannedCapture(raw))
  const demoRoot = resolve(options.demoRoot)
  await mkdir(demoRoot, { recursive: true })
  const fixtureRepo = await createFixtureRepository(demoRoot)
  await prepareCaptureState(demoRoot, fixtureRepo)
  const ready = spec.setup?.readyWait ? spec.waits[spec.setup.readyWait] : undefined
  const capture = await (dependencies.createCapture ?? createPureTuiCapture)({
    repoRoot: REPO_ROOT,
    demoRoot,
    fixtureRepo,
    seedTasks: spec.setup?.seedTasks,
    pathPrefix: spec.setup?.fixtureEngines ? join(PACKAGE_ROOT, "scripts", "fixtures") : undefined,
    readyPattern: ready?.pattern,
    readyTimeoutMs: ready?.timeoutMs,
    cols: spec.viewport.cols,
    rows: spec.viewport.rows,
    protocolTimeoutMs: options.timeoutMs,
  })
  try {
    await runReplayCapture(spec, capture.terminal, captureOutput(resolve(options.outputPath)), {
      now: () => performance.now(),
      sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    })
  } finally {
    await capture.cleanup()
  }

  const log = dependencies.log ?? console.log
  log(`PureTUI replay capture: ${resolve(options.outputPath)}`)
  // Demo roots contain diagnostics and are intentionally retained. The flag is
  // accepted for CLI compatibility and makes that retention explicit to users.
  if (options.keepDemoRoot) log(`Retained demo root: ${demoRoot}`)
  return { outputPath: resolve(options.outputPath), demoRoot }
}

const parseArguments = (args: readonly string[]): CapturePureTuiOptions => {
  let specPath = DEFAULT_SPEC
  let outputPath = DEFAULT_OUTPUT
  let keepDemoRoot = false
  let timeoutMs: number | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--keep-demo-root") {
      keepDemoRoot = true
      continue
    }
    if (arg === "--spec" || arg === "--output" || arg === "--timeout-ms") {
      const value = args[++index]
      if (!value) throw new Error(`${arg} requires a value`)
      if (arg === "--spec") specPath = resolve(value)
      if (arg === "--output") outputPath = resolve(value)
      if (arg === "--timeout-ms") {
        timeoutMs = Number.parseInt(value, 10)
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer")
      }
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return {
    specPath,
    outputPath,
    keepDemoRoot,
    timeoutMs,
    demoRoot: join(PACKAGE_ROOT, `.capture-home-puretui-${process.pid}-${Date.now()}`),
  }
}

if (import.meta.main) {
  try {
    await capturePureTui(parseArguments(process.argv.slice(2)))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
