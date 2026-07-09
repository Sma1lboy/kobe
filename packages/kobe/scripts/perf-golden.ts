/**
 * perf-golden — kobe's golden performance testcases (issue #28 follow-up).
 *
 * A release-ritual doctor: five end-to-end metrics measured against a REAL
 * sandbox pty-host (throwaway KOBE_HOME_DIR, never touches ~/.kobe), each
 * with a committed golden ceiling. A new version that regresses past a
 * ceiling fails loudly (exit 1). Ceilings are deliberately 2-3× the
 * numbers measured on the reference machine (2026-07-09, Apple Silicon)
 * so machine variance doesn't flake — this gate catches REGRESSIONS
 * (something got structurally slower/fatter), not noise.
 *
 * Run: `bun scripts/perf-golden.ts` (from packages/kobe) or
 * `bun run perf:golden`. `--json` for machine-readable output.
 *
 * Metrics:
 *   cli-startup       bun cold-starts the CLI import graph (--version)
 *   pty-spawn         acquire → first output chunk (host warm)
 *   pty-wake          parked tab: re-acquire → full ring replay visible
 *   mem-per-tab       hot-tab RSS cost, 10 visited tabs vs 1
 *   park-heap-reclaim JS-heap % released by parking those tabs
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const JSON_MODE = process.argv.includes("--json")
const PKG_ROOT = join(import.meta.dir, "..")

/** Golden ceilings — regress past these and the run fails. */
const GOLDEN = {
  "cli-startup-ms": 2500,
  "pty-spawn-ms": 1500,
  "pty-wake-ms": 200,
  "mem-per-tab-mb": 18,
  "park-heap-reclaim-pct-min": 40,
}

process.env.KOBE_HOME_DIR = mkdtempSync(join(tmpdir(), "kobe-perf-golden-"))
process.env.KOBE_PTY_IDLE_EXIT_MS = "2000"

const { PtyRegistry } = await import("../src/tui/panes/terminal/registry.ts")

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
const results: { metric: string; value: number; ceiling: number; ok: boolean; unit: string }[] = []
function record(metric: string, value: number, ceiling: number, unit: string, higherIsBetter = false): void {
  const ok = higherIsBetter ? value >= ceiling : value <= ceiling
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
  record("cli-startup-ms", median(runs), GOLDEN["cli-startup-ms"], "ms")
}

const reg = new PtyRegistry()

/* 2 — spawn → first output (host warm after a throwaway warmup). */
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
  record("pty-spawn-ms", performance.now() - t0, GOLDEN["pty-spawn-ms"], "ms")
}

/* 3 — park → wake with a full ring (the tab-switch-back experience). */
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
  record("pty-wake-ms", median(runs), GOLDEN["pty-wake-ms"], "ms")
}

/* 4+5 — per-tab memory and park reclaim (10 visited tabs). */
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
  const rssHot = rssMb()
  record("mem-per-tab-mb", (rssHot - rss1) / 10, GOLDEN["mem-per-tab-mb"], "MB")

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
  const reclaim = ((heapBefore - heapMb()) / heapBefore) * 100
  record("park-heap-reclaim-pct-min", reclaim, GOLDEN["park-heap-reclaim-pct-min"], "%", true)
}

/* Teardown: end every sandbox session so the throwaway host idle-exits. */
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

if (JSON_MODE) {
  console.log(JSON.stringify({ golden: GOLDEN, results }, null, 2))
} else {
  console.log("kobe perf-golden")
  for (const r of results) {
    const bound = r.metric.endsWith("-min") ? `≥${r.ceiling}` : `≤${r.ceiling}`
    console.log(
      `  ${r.ok ? "ok  " : "FAIL"}  ${r.metric.padEnd(26)} ${String(r.value).padStart(8)} ${r.unit}  (golden ${bound}${r.unit})`,
    )
  }
}
process.exit(results.every((r) => r.ok) ? 0 : 1)
