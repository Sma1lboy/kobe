/**
 * perf-golden — kobe's golden performance testcases (issue #28 follow-up).
 *
 * A release-ritual doctor: end-to-end metrics measured against REAL
 * sandbox infrastructure (throwaway KOBE_HOME_DIR pty-host + daemon
 * server on a temp socket — never touches ~/.kobe), each with a golden
 * ceiling committed in the ONE `GOLDEN` table below. A new version that
 * regresses past a ceiling fails loudly (exit 1). Ceilings sit 2-3× the
 * reference-machine numbers (2026-07-09, Apple Silicon) so machine
 * variance doesn't flake — this gate catches STRUCTURAL regressions
 * (something got slower/fatter), not jitter.
 *
 * Run from packages/kobe: `bun run perf:golden` (full, ~90s — includes
 * the standalone-binary compile) · `--fast` skips the compile (~30s) ·
 * `--json` for machine-readable output.
 */

import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const JSON_MODE = process.argv.includes("--json")
const FAST = process.argv.includes("--fast")
const PKG_ROOT = join(import.meta.dir, "..")

/**
 * THE metrics table — every golden testcase's ceiling (or floor for
 * `-min` metrics) lives here and only here.
 */
const GOLDEN = {
  "cli-startup-ms": 2500, // bun cold-starts the CLI import graph (--version)
  "pty-spawn-ms": 1500, // registry acquire → first output chunk (host warm)
  "pty-wake-ms": 200, // parked tab: re-acquire → full ring replay visible
  "vt-1mb-parse-ms": 3000, // 1MB of raw VT output → parsed snapshot visible
  "daemon-connect-replay-ms": 500, // socket connect + subscribe → snapshot replayed
  "daemon-rpc-p50-ms": 20, // daemon.status round-trip, median of 20
  "mem-per-tab-mb": 18, // hot-tab RSS cost, 10 visited tabs
  "park-heap-reclaim-pct-min": 40, // JS-heap % released by parking those tabs
  "binary-size-mb": 150, // standalone `bun build --compile` output (skipped by --fast)
  "binary-compile-ms": 240_000, // scripts/compile.ts wall time (skipped by --fast)
}

process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-perf-golden-"))
process.env.KOBE_PTY_IDLE_EXIT_MS = "2000"

const { PtyRegistry } = await import("../src/tui/panes/terminal/registry.ts")
const { XtermTaskPty } = await import("../src/tui/panes/terminal/pty-xterm-base.ts")

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const rssMb = () => process.memoryUsage().rss / 1048576
const heapMb = () => (require("bun:jsc") as { heapStats(): { heapSize: number } }).heapStats().heapSize / 1048576
const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0
const text = (p: { capture(): readonly (readonly { text: string }[])[] }) =>
  p
    .capture()
    .map((row) => row.map((c) => c.text).join(""))
    .join("\n")

const BASH = { command: ["/bin/bash", "--norc", "--noprofile", "-i"], cols: 180, rows: 50 }
const results: { metric: string; value: number; ceiling: number; ok: boolean; unit: string; skipped?: boolean }[] = []
function record(metric: keyof typeof GOLDEN, value: number, unit: string): void {
  const ceiling = GOLDEN[metric]
  const ok = metric.endsWith("-min") ? value >= ceiling : value <= ceiling
  results.push({ metric, value: Math.round(value * 10) / 10, ceiling, ok, unit })
}

/* 1 — CLI cold start (import graph weight). */
{
  const runs: number[] = []
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now()
    Bun.spawnSync(["bun", join(PKG_ROOT, "src/cli/index.ts"), "--version"], { stdout: "ignore", stderr: "ignore" })
    runs.push(performance.now() - t0)
  }
  record("cli-startup-ms", median(runs), "ms")
}

/* 2 — VT parse throughput: 1MB of output through the shared xterm base
 * with a live subscriber (the streaming-engine hot path). No host —
 * this isolates the emulator+snapshot pipeline. */
{
  class FakeTransportPty extends XtermTaskPty {
    protected transportWrite(_data: string): void {}
    protected transportResize(_cols: number, _rows: number): void {}
    protected transportKill(): void {}
    pump(data: string): void {
      this.feed(data)
    }
  }
  const pty = new FakeTransportPty({ taskId: "vt", cwd: "/", cols: 180, rows: 50 })
  const off = pty.onData(() => {})
  const line = `${"x".repeat(96)}\r\n` // ~100B/line
  const chunk = line.repeat(107) // ~10KB chunks, 100 chunks ≈ 1MB
  const t0 = performance.now()
  for (let i = 0; i < 100; i++) pty.pump(chunk)
  pty.pump("VT_DONE_MARK\r\n")
  while (!text(pty).includes("VT_DONE_MARK")) {
    if (performance.now() - t0 > 30_000) throw new Error("vt probe: timeout")
    await sleep(5)
  }
  record("vt-1mb-parse-ms", performance.now() - t0, "ms")
  off()
  pty.kill()
}

/* 3 — daemon socket: connect+replay, then RPC round-trips. Real server
 * on a temp socket, minimal orchestrator (the daemon test double). */
{
  const { startDaemonServer } = await import("@sma1lboy/kobe-daemon/daemon/server")
  const { daemonRuntime } = await import("../src/core/daemon-runtime.ts")
  const { KobeDaemonClient } = await import("@sma1lboy/kobe-daemon/client")
  const dir = mkdtempSync(join(tmpdir(), "kobe-perf-daemon-"))
  const orch = {
    subscribeTasks: (listener: (snapshot: unknown[]) => void) => {
      listener([])
      return () => {}
    },
    listTasks: () => [],
    activeTaskSignal: () => () => null,
  } as unknown as Parameters<typeof startDaemonServer>[0]
  const server = await startDaemonServer(orch, {
    runtime: daemonRuntime,
    socketPath: join(dir, "daemon.sock"),
    pidPath: join(dir, "daemon.pid"),
    homeDir: dir,
    updatePollMs: 0,
    autoTitlePollMs: 0,
    uiPrefsDebounceMs: 0,
    keybindingsDebounceMs: 25,
    worktreeChangesTickMs: 0,
  })
  const client = new KobeDaemonClient(join(dir, "daemon.sock"))
  let sawSnapshot = false
  client.on("task.snapshot", () => {
    sawSnapshot = true
  })
  const t0 = performance.now()
  await client.connect()
  await client.subscribe()
  while (!sawSnapshot) {
    if (performance.now() - t0 > 10_000) throw new Error("daemon probe: no snapshot replay")
    await sleep(2)
  }
  record("daemon-connect-replay-ms", performance.now() - t0, "ms")
  const rpcs: number[] = []
  for (let i = 0; i < 20; i++) {
    const r0 = performance.now()
    await client.request("daemon.status", {})
    rpcs.push(performance.now() - r0)
  }
  record("daemon-rpc-p50-ms", median(rpcs), "ms")
  client.close()
  await server.close().catch(() => {})
}

const reg = new PtyRegistry()

/* 4 — PTY spawn → first output (host warm after a throwaway warmup). */
{
  const warm = reg.acquire("perf::warmup", "/tmp", BASH)
  await new Promise<void>((resolve) => {
    const off = warm.onData(() => {
      off()
      resolve()
    })
  })
  const t0 = performance.now()
  const pty = reg.acquire("perf::spawn", "/tmp", BASH)
  await new Promise<void>((resolve) => {
    const off = pty.onData(() => {
      off()
      resolve()
    })
  })
  record("pty-spawn-ms", performance.now() - t0, "ms")
}

/* 5 — park → wake with a full ring (the tab-switch-back experience). */
{
  const pty = reg.acquire("perf::wake", "/tmp", BASH)
  const off = pty.onData(() => {})
  await sleep(1200)
  pty.write("seq -f 'line %g of padded output to fill the host ring buffer' 1 8000; echo WAKE_MARK_$((900+9))\r")
  await sleep(5000)
  off()
  if (!text(pty).includes("WAKE_MARK_909")) throw new Error("wake probe: marker missing pre-park")
  const runs: number[] = []
  for (let i = 0; i < 3; i++) {
    reg.parkIdle(0)
    await sleep(150)
    const t0 = performance.now()
    const woken = reg.acquire("perf::wake", "/tmp", BASH)
    const offW = woken.onData(() => {})
    while (!text(woken).includes("WAKE_MARK_909")) {
      if (performance.now() - t0 > 10_000) throw new Error("wake probe: timeout")
      await sleep(5)
    }
    runs.push(performance.now() - t0)
    offW()
  }
  record("pty-wake-ms", median(runs), "ms")
}

/* 6+7 — per-tab memory and park reclaim (10 visited tabs). */
{
  const rss1 = rssMb()
  let unsubs: (undefined | (() => void))[] = []
  for (let i = 0; i < 10; i++) {
    const pty = reg.acquire(`perf::mem-${i}`, "/tmp", BASH)
    unsubs.push(pty.onData(() => {}))
  }
  await sleep(2000)
  for (let i = 0; i < 10; i++)
    reg.get(`perf::mem-${i}`)?.write("seq -f 'line %g of simulated engine output padding' 1 6000\r")
  await sleep(5000)
  record("mem-per-tab-mb", (rssMb() - rss1) / 10, "MB")

  for (let i = 0; i < unsubs.length; i++) {
    unsubs[i]?.()
    unsubs[i] = undefined
  }
  unsubs = []
  const heapBefore = heapMb()
  reg.parkIdle(0)
  Bun.gc(true)
  await sleep(800)
  Bun.gc(true)
  record("park-heap-reclaim-pct-min", ((heapBefore - heapMb()) / heapBefore) * 100, "%")
}

/* Teardown pty sandbox before the (long) compile. */
for (const key of [
  "perf::warmup",
  "perf::spawn",
  "perf::wake",
  ...Array.from({ length: 10 }, (_, i) => `perf::mem-${i}`),
]) {
  try {
    reg.acquire(key, "/tmp", { command: ["/bin/bash"] }).kill()
  } catch {
    /* already gone */
  }
}
await sleep(300)

/* 8+9 — standalone binary: compile time + size (the release artifact and
 * the native-addon red line — a dep that breaks `--compile` fails here). */
if (!FAST) {
  const t0 = performance.now()
  const proc = Bun.spawnSync(["bun", "run", "scripts/compile.ts"], { cwd: PKG_ROOT, stdout: "ignore", stderr: "pipe" })
  if (proc.exitCode !== 0) throw new Error(`compile smoke failed:\n${proc.stderr.toString().slice(-800)}`)
  record("binary-compile-ms", performance.now() - t0, "ms")
  const bin = join(PKG_ROOT, "release-bin/kobe")
  record("binary-size-mb", statSync(bin).size / 1048576, "MB")
  // The native-addon red line trips at RUNTIME import, not at bundling —
  // the compiled artifact must actually start.
  const smoke = Bun.spawnSync([bin, "--version"], { stdout: "ignore", stderr: "pipe" })
  if (smoke.exitCode !== 0) throw new Error(`compiled binary won't start:\n${smoke.stderr.toString().slice(-800)}`)
}

if (JSON_MODE) {
  console.log(JSON.stringify({ golden: GOLDEN, fast: FAST, results }, null, 2))
} else {
  console.log(`kobe perf-golden${FAST ? " (--fast: binary metrics skipped)" : ""}`)
  for (const r of results) {
    const bound = r.metric.endsWith("-min") ? `≥${r.ceiling}` : `≤${r.ceiling}`
    console.log(
      `  ${r.ok ? "ok  " : "FAIL"}  ${r.metric.padEnd(26)} ${String(r.value).padStart(9)} ${r.unit}  (golden ${bound}${r.unit})`,
    )
  }
}
process.exit(results.every((r) => r.ok) ? 0 : 1)
