/**
 * kobe perf stress harness — produce a reproducible RSS / CPU baseline.
 *
 * Goal: answer "how much memory does kobe use under N tabs / under heavy
 * streaming?" with concrete numbers. Not a CI gate — the host
 * (macOS/Linux, idle vs loaded, terminal emulator) changes the answer.
 *
 * How to re-run:
 *
 *   node --experimental-strip-types --no-warnings scripts/perf-stress.ts > docs/perf/baseline.md
 *
 * The script writes a markdown report to stdout. Redirect into
 * `docs/perf/baseline.md` (or anywhere) to overwrite the committed
 * baseline. The script never edits files itself.
 *
 * Why node, not bun:
 *   `node-pty`'s `onData` callback never fires under Bun (a known
 *   incompat — the same reason `test/behavior/driver.ts` documents
 *   that vitest must run under node, not bun). Running this script
 *   under bun yields zero PTY output and a `waitFor` timeout. Node
 *   24's `--experimental-strip-types` lets us run the TS file
 *   directly without a bundler. Requires node >= 22.6.
 *
 * What it measures (each scenario uses fresh fixtures, fresh kobe
 * process, fresh KOBE_HOME_DIR):
 *
 *   1. Cold boot       — spawn kobe against an empty store; sample RSS
 *                         3x at 1s intervals after first paint.
 *   2. N pre-seeded    — pre-write `tasks.json` with N tasks (1, 5, 20),
 *                         boot, sample RSS after the sidebar shows the
 *                         last-seeded task.
 *   3. Streaming       — boot, create one task, pump 1000
 *                         `assistant.delta` events through the fake
 *                         engine, sample RSS + CPU 5x over the burst.
 *
 * Mechanism (mirrors `test/behavior/g3-chat.test.ts`):
 *   - `spawnKobe()` from `test/behavior/driver.ts` brings up kobe under
 *     a PTY with `KOBE_TEST_ENGINE=fake`.
 *   - The fake engine's HTTP side-channel (`/script`, `/finish`) lets us
 *     pump events from this script.
 *   - RSS / CPU come from `ps -o rss=,pcpu= -p <pid>` — works on macOS
 *     and Linux without extra deps. The pid is the bun process spawned
 *     under the PTY (we read it back from node-pty's `pid` getter via a
 *     small extension to the driver, see `pidOf()` below).
 *
 * Safety / scope:
 *   - Each scenario runs to completion; failures in one don't poison the
 *     others. We collect what we can and continue.
 *   - All tmp dirs are under `os.tmpdir()` and are deleted at exit.
 *   - The script does not optimize anything. It only reports numbers.
 */

import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import * as pty from "node-pty"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..")
const REPO_INIT = path.join(REPO_ROOT, "test", "behavior", "fixtures", "repo-init.sh")

/* --------------------------------------------------------------------- */
/*  Inline PTY driver                                                    */
/*                                                                       */
/*  We don't import from `test/behavior/driver.ts` because node's        */
/*  strip-types loader can't follow the driver's extensionless           */
/*  `./screen` import, and Bun + node-pty does not deliver `onData`      */
/*  callbacks (a known incompat — vitest tests work because vitest       */
/*  runs under Node). So we inline the small pieces we need: ANSI strip, */
/*  the `KobeHandle` shape, and `spawnKobe`. This script must run under  */
/*  `bun --bun` ... no — `node` (see how-to-rerun in the doc-comment).   */
/* --------------------------------------------------------------------- */

interface KobeHandle {
  sendKeys(seq: string): Promise<void>
  typeText(s: string): Promise<void>
  capture(): Promise<string>
  captureRaw(): string
  waitFor(predicate: (screen: string) => boolean, timeoutMs?: number): Promise<string>
  exit(): Promise<void>
  readonly closed: boolean
  readonly pid: number | undefined
}

interface SpawnKobeOpts {
  cwd?: string
  cols?: number
  rows?: number
  env?: Record<string, string>
  settleMs?: number
}

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
const DEFAULT_SETTLE_MS = 100
const DEFAULT_TIMEOUT_MS = 5_000
const EXIT_GRACE_MS = 750

function ensureSpawnHelperExecutable(): void {
  const npPkg = path.join(REPO_ROOT, "node_modules", "node-pty")
  if (!fs.existsSync(npPkg)) return
  const arch = `${process.platform}-${process.arch}`
  const helper = path.join(npPkg, "prebuilds", arch, "spawn-helper")
  if (!fs.existsSync(helper)) return
  try {
    const st = fs.statSync(helper)
    if ((st.mode & 0o111) === 0) fs.chmodSync(helper, st.mode | 0o755)
  } catch {
    /* best effort */
  }
}

function stripAnsi(input: string): string {
  let out = ""
  let i = 0
  const n = input.length
  while (i < n) {
    const ch = input[i]
    const code = input.charCodeAt(i)
    if (ch === "\x1b") {
      const next = input[i + 1]
      if (next === "[") {
        i += 2
        while (i < n) {
          const c = input.charCodeAt(i)
          if (c >= 0x40 && c <= 0x7e) {
            i += 1
            break
          }
          i += 1
        }
        continue
      }
      if (next === "]") {
        i += 2
        while (i < n) {
          const c = input[i]
          if (c === "\x07") {
            i += 1
            break
          }
          if (c === "\x1b" && input[i + 1] === "\\") {
            i += 2
            break
          }
          i += 1
        }
        continue
      }
      if (next === "P" || next === "X" || next === "^" || next === "_") {
        i += 2
        while (i < n) {
          const c = input[i]
          if (c === "\x1b" && input[i + 1] === "\\") {
            i += 2
            break
          }
          i += 1
        }
        continue
      }
      i += 2
      continue
    }
    if (ch === "\n" || ch === "\r" || ch === "\t") {
      out += ch
      i += 1
      continue
    }
    if (code < 0x20 || code === 0x7f) {
      i += 1
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function normalizeScreen(raw: string): string {
  const stripped = stripAnsi(raw)
  const lines = stripped.split(/\r\n|\r|\n/).map((l) => l.replace(/\s+$/u, ""))
  while (lines.length > 0 && lines[0] === "") lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
  return lines.join("\n")
}

async function spawnKobe(opts: SpawnKobeOpts = {}): Promise<KobeHandle> {
  ensureSpawnHelperExecutable()
  const cwd = opts.cwd ?? REPO_ROOT
  const cols = opts.cols ?? DEFAULT_COLS
  const rows = opts.rows ?? DEFAULT_ROWS
  const settleMs = opts.settleMs ?? DEFAULT_SETTLE_MS
  const command = "bun"
  const args = ["--preload", "@opentui/solid/preload", "--conditions=browser", path.join(cwd, "src", "cli", "index.ts")]
  const baseEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") baseEnv[k] = v
  }
  const env: Record<string, string> = {
    ...baseEnv,
    TERM: "xterm-256color",
    COLUMNS: String(cols),
    LINES: String(rows),
    CI: "1",
    ...(opts.env ?? {}),
  }
  const term = pty.spawn(command, args, { name: "xterm-256color", cols, rows, cwd, env })
  let buffer = ""
  let closed = false
  term.onData((chunk) => {
    buffer += chunk
    if (buffer.length > 1_000_000) buffer = buffer.slice(-500_000)
  })
  term.onExit(() => {
    closed = true
  })
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
  return {
    async sendKeys(seq) {
      if (closed) throw new Error("kobe pty is closed")
      term.write(seq)
      await sleep(settleMs)
    },
    async typeText(s) {
      if (closed) throw new Error("kobe pty is closed")
      term.write(s)
      await sleep(settleMs)
    },
    async capture() {
      return normalizeScreen(buffer)
    },
    captureRaw() {
      return buffer
    },
    async waitFor(predicate, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const deadline = Date.now() + timeoutMs
      let last = ""
      while (Date.now() < deadline) {
        last = normalizeScreen(buffer)
        if (predicate(last)) return last
        await sleep(50)
      }
      throw new Error(`waitFor: predicate not met within ${timeoutMs}ms. Last screen:\n${last || "(empty)"}`)
    },
    async exit() {
      if (closed) return
      try {
        term.kill("SIGTERM")
      } catch {
        /* already dead */
      }
      const deadline = Date.now() + EXIT_GRACE_MS
      while (!closed && Date.now() < deadline) await sleep(25)
      if (!closed) {
        try {
          term.kill("SIGKILL")
        } catch {
          /* already dead */
        }
        for (let i = 0; i < 20 && !closed; i++) await sleep(25)
      }
    },
    get closed() {
      return closed
    },
    get pid() {
      return term.pid
    },
  }
}

/* --------------------------------------------------------------------- */
/*  Helpers                                                              */
/* --------------------------------------------------------------------- */

/**
 * Resolve the actual bun-running-kobe pid given the pid node-pty handed
 * us. On macOS, `pty.spawn()` returns the spawn-helper pid, which then
 * exec'd into bun (so the helper *is* bun by then — same pid, comm name
 * "bun"). On Linux, the returned pid is the bun process directly. If
 * the returned pid's comm is already "bun", use it; otherwise walk one
 * level of children to find a bun process. Returns null on failure.
 */
function pidOfKobe(handlePid: number | undefined): number | null {
  if (typeof handlePid !== "number" || !Number.isFinite(handlePid)) return null
  if (isBun(handlePid)) return handlePid
  const r = spawnSync("pgrep", ["-P", String(handlePid)], { encoding: "utf8" })
  if (r.status !== 0) return null
  for (const line of r.stdout.trim().split("\n").filter(Boolean)) {
    const cpid = Number.parseInt(line, 10)
    if (Number.isFinite(cpid) && isBun(cpid)) return cpid
  }
  // Process is alive but comm hasn't settled yet — fall back to
  // returning the handle pid itself; ps will still give us its RSS.
  return handlePid
}

function isBun(pid: number): boolean {
  const r = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" })
  if (r.status !== 0) return false
  return r.stdout.trim().toLowerCase().includes("bun")
}

interface PsSample {
  /** Resident set size in KB (ps default). */
  rssKb: number
  /** Percent CPU (one-second sample, ps default). */
  pcpu: number
}

/** Read RSS + CPU for a pid via `ps`. Returns null if the process is gone. */
function sample(pid: number): PsSample | null {
  const r = spawnSync("ps", ["-o", "rss=,pcpu=", "-p", String(pid)], { encoding: "utf8" })
  if (r.status !== 0) return null
  const out = r.stdout.trim()
  if (!out) return null
  // ps may output multiple whitespace-separated columns. First two are rss + pcpu.
  const parts = out.split(/\s+/)
  if (parts.length < 2) return null
  const rssKb = Number.parseFloat(parts[0] ?? "")
  const pcpu = Number.parseFloat(parts[1] ?? "")
  if (!Number.isFinite(rssKb) || !Number.isFinite(pcpu)) return null
  return { rssKb, pcpu }
}

function mean(xs: number[]): number {
  if (xs.length === 0) return Number.NaN
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function max(xs: number[]): number {
  return xs.reduce((a, b) => (a > b ? a : b), Number.NEGATIVE_INFINITY)
}

function fmtMb(kb: number): string {
  return `${(kb / 1024).toFixed(1)} MB`
}

function fmtPct(p: number): string {
  return `${p.toFixed(1)}%`
}

async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.unref()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address()
      if (addr && typeof addr === "object") {
        const port = addr.port
        srv.close(() => resolve(port))
      } else {
        srv.close()
        reject(new Error("could not allocate a free port"))
      }
    })
  })
}

async function scriptEngine(
  port: number,
  endpoint: "/script" | "/finish",
  payload: Record<string, unknown>,
): Promise<void> {
  const body = JSON.stringify(payload)
  // No explicit content-length — fetch sets it to the byte length.
  // Setting it from `body.length` (character count) breaks for any
  // multi-byte UTF-8 (the fake-engine handler uses Content-Length to
  // bound how many bytes to read; mismatch → handler never runs).
  const res = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`fake-engine ${endpoint} failed: ${res.status} ${text}`)
  }
}

async function waitForFakeServer(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    try {
      await scriptEngine(port, "/script", { sessionId: "__warmup__", events: [] })
      return
    } catch (err) {
      lastErr = err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
  throw new Error(`fake-engine server never came up on :${port}: ${lastErr}`)
}

/** Build a fixture git repo for a scenario. Returns its absolute path. */
function makeFixtureRepo(parentDir: string, name: string): string {
  const repo = path.join(parentDir, name)
  const r = spawnSync("bash", [REPO_INIT, repo], { encoding: "utf8" })
  if (r.status !== 0) {
    throw new Error(`repo-init.sh failed for ${repo}: ${r.stderr}\n${r.stdout}`)
  }
  return repo
}

/** Pre-seed `<homeDir>/.kobe/tasks.json` with N synthetic tasks. */
function seedTasksJson(homeDir: string, repo: string, n: number): void {
  const dir = path.join(homeDir, ".kobe")
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  const tasks: unknown[] = []
  for (let i = 0; i < n; i++) {
    // Use simple sortable ids — we don't need real ULIDs for the loader,
    // it only requires `id` is a string.
    const id = `seed${String(i).padStart(6, "0")}`
    const tabId = `${id}-tab`
    tasks.push({
      id,
      title: `seeded task ${i + 1}`,
      repo,
      branch: `kobe/seed-${i}`,
      worktreePath: path.join(repo, ".worktrees", `seed-${i}`),
      sessionId: null,
      tabs: [{ id: tabId, sessionId: null, createdAt: now }],
      activeTabId: tabId,
      status: "backlog",
      archived: false,
      createdAt: now,
      updatedAt: now,
    })
  }
  fs.writeFileSync(path.join(dir, "tasks.json"), JSON.stringify({ version: 2, tasks }, null, 2))
}

interface ScenarioResult {
  name: string
  setup: string
  rssKb: number[]
  cpu: number[]
  notes?: string
  /** Optional extra structured info (e.g. delta count, duration). */
  extra?: Record<string, string | number>
}

function summary(s: ScenarioResult): string {
  const rssMean = mean(s.rssKb)
  const rssMax = max(s.rssKb)
  const cpuMean = mean(s.cpu)
  const cpuMax = max(s.cpu)
  const lines: string[] = []
  lines.push(`### ${s.name}`)
  lines.push("")
  lines.push(s.setup)
  lines.push("")
  lines.push(`- Samples: ${s.rssKb.length}`)
  if (s.rssKb.length > 0) {
    lines.push(`- RSS mean: ${fmtMb(rssMean)} | max: ${fmtMb(rssMax)}`)
    lines.push(`- RSS samples (MB): ${s.rssKb.map((k) => (k / 1024).toFixed(1)).join(", ")}`)
  }
  if (s.cpu.length > 0) {
    lines.push(`- CPU mean: ${fmtPct(cpuMean)} | max: ${fmtPct(cpuMax)}`)
  }
  if (s.extra) {
    for (const [k, v] of Object.entries(s.extra)) lines.push(`- ${k}: ${v}`)
  }
  if (s.notes) {
    lines.push("")
    lines.push(s.notes)
  }
  lines.push("")
  return lines.join("\n")
}

/* --------------------------------------------------------------------- */
/*  Scenarios                                                            */
/* --------------------------------------------------------------------- */

interface ScenarioCtx {
  tmpRoot: string
  homeDir: string
}

function freshCtx(label: string): ScenarioCtx {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), `kobe-perf-${label}-`))
  const homeDir = path.join(tmpRoot, "home")
  fs.mkdirSync(homeDir, { recursive: true })
  return { tmpRoot, homeDir }
}

function cleanCtx(ctx: ScenarioCtx): void {
  try {
    fs.rmSync(ctx.tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

async function bootKobe(homeDir: string, port: number, fakeEngine = true): Promise<KobeHandle> {
  const env: Record<string, string> = { KOBE_HOME_DIR: homeDir }
  if (fakeEngine) {
    env.KOBE_TEST_ENGINE = "fake"
    env.KOBE_TEST_FAKE_PORT = String(port)
  }
  const k = await spawnKobe({ env, cols: 120, rows: 40 })
  // Wait for the boot screen.
  await k.waitFor((s) => s.includes("kobe"), 20_000)
  return k
}

async function scenarioColdBoot(): Promise<ScenarioResult> {
  const ctx = freshCtx("coldboot")
  const port = await pickFreePort()
  const setup =
    "Empty store. Spawn kobe under PTY (`KOBE_TEST_ENGINE=fake`, empty `KOBE_HOME_DIR`). Wait for first paint, then sample RSS+CPU 3 times at 1s intervals."
  const rssKb: number[] = []
  const cpu: number[] = []
  let kobe: KobeHandle | null = null
  let notes: string | undefined
  try {
    kobe = await bootKobe(ctx.homeDir, port)
    // Let the boot screen settle past first paint.
    await new Promise((r) => setTimeout(r, 1500))
    const pid = pidOfKobe(kobe.pid)
    if (!pid) {
      notes = "could not resolve kobe child pid — sample skipped"
    } else {
      for (let i = 0; i < 3; i++) {
        const s = sample(pid)
        if (s) {
          rssKb.push(s.rssKb)
          cpu.push(s.pcpu)
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  } finally {
    if (kobe && !kobe.closed) await kobe.exit()
    cleanCtx(ctx)
  }
  return { name: "Cold boot", setup, rssKb, cpu, notes }
}

async function scenarioNTasks(n: number): Promise<ScenarioResult> {
  const ctx = freshCtx(`n${n}`)
  const port = await pickFreePort()
  const repo = makeFixtureRepo(ctx.tmpRoot, "fixture-repo")
  seedTasksJson(ctx.homeDir, repo, n)
  const setup = `Pre-seed \`tasks.json\` with **${n}** synthetic tasks (all status=backlog, sharing one fixture repo). Boot kobe, wait for the sidebar to render, sample 3x at 1s intervals.`
  const rssKb: number[] = []
  const cpu: number[] = []
  let kobe: KobeHandle | null = null
  let notes: string | undefined
  try {
    kobe = await bootKobe(ctx.homeDir, port)
    // Wait for one of the seeded titles to render in the sidebar.
    try {
      await kobe.waitFor((s) => s.includes("seeded task"), 15_000)
    } catch {
      notes = "sidebar never rendered seeded titles in 15s — kobe may not have surfaced them"
    }
    await new Promise((r) => setTimeout(r, 500))
    const pid = pidOfKobe(kobe.pid)
    if (!pid) {
      notes = `${notes ? `${notes}; ` : ""}could not resolve kobe child pid`
    } else {
      for (let i = 0; i < 3; i++) {
        const s = sample(pid)
        if (s) {
          rssKb.push(s.rssKb)
          cpu.push(s.pcpu)
        }
        await new Promise((r) => setTimeout(r, 1000))
      }
    }
  } finally {
    if (kobe && !kobe.closed) await kobe.exit()
    cleanCtx(ctx)
  }
  return {
    name: `Pre-seeded ${n} tasks`,
    setup,
    rssKb,
    cpu,
    notes,
    extra: { "tasks seeded": n },
  }
}

async function scenarioStreaming(deltaCount: number): Promise<ScenarioResult> {
  const ctx = freshCtx("stream")
  const port = await pickFreePort()
  const repo = makeFixtureRepo(ctx.tmpRoot, "stream-repo")
  const setup = `Boot kobe with the fake engine. Create a single task via the new-task dialog. Pump **${deltaCount}** \`assistant.delta\` events into the engine in chunks of 100, sampling RSS+CPU after each chunk. Final sample is taken ~1s after the engine signals \`done\`.`
  const rssKb: number[] = []
  const cpu: number[] = []
  let kobe: KobeHandle | null = null
  let notes: string | undefined
  let preStreamRssKb: number | null = null
  let postStreamRssKb: number | null = null
  try {
    kobe = await bootKobe(ctx.homeDir, port)
    await waitForFakeServer(port)

    // Pre-script the engine so the first session id (`fake-1`) is queued
    // up before the prompt is sent to the composer (post-create).
    const CHUNK_SIZE = 100
    const text = "lorem ipsum dolor sit amet, consectetur adipiscing elit. " // 56 bytes/event
    const firstBatch = Array.from({ length: CHUNK_SIZE }, () => ({
      type: "assistant.delta" as const,
      text,
    }))
    await scriptEngine(port, "/script", { sessionId: "fake-1", events: firstBatch })

    // Open new-task dialog and fill it in. Wave 4 dialog dropped the
    // prompt field; first focus is on the repo input (prefilled with
    // cwd). See `test/behavior/g3-chat.test.ts` `fillNewTaskDialog`.
    await kobe.sendKeys("n")
    await kobe.waitFor((s) => s.includes("New task"), 5_000)
    // Clear default cwd prefill, then type our fixture repo.
    for (let i = 0; i < 200; i++) await kobe.sendKeys("\x7f")
    await kobe.typeText(repo)
    await kobe.sendKeys("\r")
    // Composer auto-focuses post-create. Brief settle, then send a prompt.
    await new Promise((r) => setTimeout(r, 250))
    await kobe.typeText("perf stream task")
    await kobe.sendKeys("\r")

    // Wait for the chat pane to start showing assistant text.
    await kobe.waitFor((s) => s.includes("lorem ipsum"), 20_000)

    const pid = pidOfKobe(kobe.pid)
    if (!pid) {
      notes = "could not resolve kobe child pid"
    } else {
      const pre = sample(pid)
      if (pre) preStreamRssKb = pre.rssKb

      // Pump remaining chunks; after each, sample.
      const remaining = deltaCount - CHUNK_SIZE
      const chunks = Math.max(0, Math.ceil(remaining / CHUNK_SIZE))
      for (let i = 0; i < chunks; i++) {
        const size = Math.min(CHUNK_SIZE, remaining - i * CHUNK_SIZE)
        const batch = Array.from({ length: size }, () => ({
          type: "assistant.delta" as const,
          text,
        }))
        await scriptEngine(port, "/script", { sessionId: "fake-1", events: batch })
        // Small breather so the pump can drain a bit before sampling.
        await new Promise((r) => setTimeout(r, 200))
        const s = sample(pid)
        if (s) {
          rssKb.push(s.rssKb)
          cpu.push(s.pcpu)
        }
      }

      // Signal done, wait for things to settle, take a final sample.
      await scriptEngine(port, "/script", { sessionId: "fake-1", events: [{ type: "done" as const }] })
      await scriptEngine(port, "/finish", { sessionId: "fake-1" })
      await new Promise((r) => setTimeout(r, 1500))
      const post = sample(pid)
      if (post) {
        postStreamRssKb = post.rssKb
        rssKb.push(post.rssKb)
        cpu.push(post.pcpu)
      }
    }
  } catch (err) {
    notes = `error during streaming scenario: ${(err as Error).message}`
  } finally {
    if (kobe && !kobe.closed) await kobe.exit()
    cleanCtx(ctx)
  }
  const extra: Record<string, string | number> = { "delta events": deltaCount }
  if (preStreamRssKb !== null) extra["RSS at first paint"] = fmtMb(preStreamRssKb)
  if (postStreamRssKb !== null) extra["RSS post-stream (settled)"] = fmtMb(postStreamRssKb)
  if (preStreamRssKb !== null && postStreamRssKb !== null) {
    extra["delta over stream"] = fmtMb(postStreamRssKb - preStreamRssKb)
  }
  return { name: `Streaming ${deltaCount} assistant.delta events`, setup, rssKb, cpu, notes, extra }
}

/* --------------------------------------------------------------------- */
/*  Main                                                                 */
/* --------------------------------------------------------------------- */

function envInfo(): string {
  const platform = process.platform
  const arch = process.arch
  const cpuModel = os.cpus()[0]?.model ?? "unknown"
  const cpuCount = os.cpus().length
  const totalMemGb = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1)
  const release = os.release()
  const bun = process.versions.bun ?? "n/a"
  const node = process.versions.node ?? "n/a"
  const lines = [
    `- OS: ${platform} ${release} (${arch})`,
    `- CPU: ${cpuModel} x${cpuCount}`,
    `- Total RAM: ${totalMemGb} GB`,
    `- Bun: ${bun}`,
    `- Node (driver): ${node}`,
    `- Date: ${new Date().toISOString()}`,
  ]
  return lines.join("\n")
}

async function main(): Promise<void> {
  if (!fs.existsSync(REPO_INIT)) {
    process.stderr.write(`missing fixture: ${REPO_INIT}\n`)
    process.exit(1)
  }

  const results: ScenarioResult[] = []

  // Scenario 1: cold boot.
  process.stderr.write("[perf] cold-boot...\n")
  results.push(await scenarioColdBoot())

  // Scenario 2: N pre-seeded tasks (1, 5, 20).
  for (const n of [1, 5, 20]) {
    process.stderr.write(`[perf] pre-seeded ${n} tasks...\n`)
    results.push(await scenarioNTasks(n))
  }

  // Scenario 3: streaming.
  process.stderr.write("[perf] streaming 1000 deltas...\n")
  results.push(await scenarioStreaming(1000))

  // Emit markdown to stdout.
  const out: string[] = []
  out.push("# kobe — performance baseline")
  out.push("")
  out.push("Auto-generated by `scripts/perf-stress.ts`. Local-only — host-dependent.")
  out.push("")
  out.push("## Hardware / environment")
  out.push("")
  out.push(envInfo())
  out.push("")
  out.push("## How to re-run")
  out.push("")
  out.push("```bash")
  out.push("node --experimental-strip-types --no-warnings scripts/perf-stress.ts > docs/perf/baseline.md")
  out.push("```")
  out.push("")
  out.push("Why node, not bun: node-pty's `onData` callback never fires under")
  out.push("Bun (same incompat that forces vitest behavior tests to run under")
  out.push("node). Requires node >= 22.6 for `--experimental-strip-types`.")
  out.push("")
  out.push("Numbers vary with host load, terminal emulator, and CI runners.")
  out.push("Hosted runners (GitHub Actions, etc.) produce different numbers and")
  out.push("are NOT comparable to local runs. Re-baseline on the same machine when")
  out.push("looking for regressions.")
  out.push("")
  out.push("## Scenarios")
  out.push("")
  for (const r of results) {
    out.push(summary(r))
  }

  // Surfaced observations (only stable, factual things — no opinions).
  out.push("## Observations")
  out.push("")
  const cold = results.find((r) => r.name === "Cold boot")
  const n20 = results.find((r) => r.name === "Pre-seeded 20 tasks")
  const stream = results.find((r) => r.name.startsWith("Streaming"))
  if (cold && cold.rssKb.length > 0) {
    out.push(`- Cold-boot RSS lands around **${fmtMb(mean(cold.rssKb))}** mean.`)
  }
  if (cold && n20 && cold.rssKb.length > 0 && n20.rssKb.length > 0) {
    const delta = mean(n20.rssKb) - mean(cold.rssKb)
    out.push(`- 20 pre-seeded tasks add **${fmtMb(delta)}** vs cold boot (delta of means).`)
  }
  if (stream?.extra && "delta over stream" in stream.extra) {
    out.push(`- Streaming 1000 \`assistant.delta\` events grew RSS by **${stream.extra["delta over stream"]}**.`)
    out.push(
      "  - The chat-store retains scrollback for the duration of the session, so growth is expected. Watch this number over time to detect unbounded retention.",
    )
  }
  out.push("")
  out.push('These are facts, not verdicts. "Looks fine" / "looks bad" calls live in PRs that act on them, not here.')
  out.push("")

  process.stdout.write(out.join("\n"))
}

main().catch((err) => {
  process.stderr.write(`perf-stress: ${(err as Error).stack ?? String(err)}\n`)
  process.exit(1)
})
