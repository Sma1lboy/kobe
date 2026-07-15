/**
 * Endurance probe for Hosted PTY parking and wake restoration.
 *
 * This deliberately runs outside CI: it creates 1–100 real hosted shell
 * sessions in a throwaway home, drives long output through each, then repeats
 * the "hide → serialize → output while hidden → wake" path. It fails only on
 * lost screen markers or a missing exact-delta wake, never wall-clock time.
 *
 *   bun run pty:soak -- --tabs=50 --cycles=5 --lines=1200
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TaskPty } from "../src/tui/panes/terminal/pty.ts"

function option(name: string, fallback: number, max: number): number {
  const value = process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`--${name} must be an integer from 1 to ${max}`)
  }
  return parsed
}

if (process.env.CI) throw new Error("pty:soak is intentionally non-CI; run it on a development machine")
if (process.env.KOBE_TERMINAL_BACKEND && process.env.KOBE_TERMINAL_BACKEND !== "hosted") {
  throw new Error("pty:soak requires the default hosted terminal backend")
}

const tabs = option("tabs", 50, 100)
const cycles = option("cycles", 3, 20)
const lines = option("lines", 1200, 5000)
const home = mkdtempSync(join(tmpdir(), "kobe-pty-soak-"))
process.env.KOBE_HOME_DIR = home
process.env.KOBE_SANDBOX_HOME_DIR = home
process.env.HOME = home
process.env.XDG_CONFIG_HOME = join(home, ".config")
process.env.KOBE_PTY_IDLE_EXIT_MS = "500"

const { KobeDaemonClient } = await import("@sma1lboy/kobe-daemon/client")
const { defaultPtyHostSocketPath } = await import("@sma1lboy/kobe-daemon/daemon/paths")
const { PtyRegistry } = await import("../src/tui/panes/terminal/registry.ts")

type PtyInventory = {
  stats?: { parkRestoreDeltas?: number; parkRestoreFallbacks?: number; ringBytes?: number; parkedSessions?: number }
}

const keys = Array.from({ length: tabs }, (_, index) => `soak::tab-${index + 1}`)
const shell = { command: ["/bin/bash", "--norc", "--noprofile", "-i"], cols: 120, rows: 36 }
const registry = new PtyRegistry()

function screenText(pty: TaskPty): string {
  return pty
    .capture()
    .map((row) => row.map((cell) => cell.text).join(""))
    .join("\n")
}

async function until(label: string, predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function workload(cycle: number, index: number): string {
  const id = `${cycle}-${index}`
  const padding = `soak-${id}-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
  return `${[
    `printf 'SOAK_READY_${id}\\n'`,
    `yes '${padding}' | head -n ${lines}`,
    "sleep 1",
    `printf 'SOAK_DELTA_${id}\\n'`,
  ].join("; ")}\r`
}

async function inventory(): Promise<PtyInventory> {
  const client = new KobeDaemonClient(defaultPtyHostSocketPath(home))
  try {
    await client.connect()
    return await client.request<PtyInventory>("pty.list", {})
  } finally {
    client.close()
  }
}

let peakRss = process.memoryUsage().rss
try {
  console.log(`kobe pty soak: ${tabs} tabs × ${cycles} park/wake cycles × ${lines} output lines`)
  let handles = keys.map((key) => registry.acquire(key, home, shell))
  let unsubs = handles.map((pty) => pty.onData(() => {}))

  for (let cycle = 1; cycle <= cycles; cycle++) {
    for (let index = 0; index < handles.length; index++) handles[index]?.write(workload(cycle, index + 1))
    await until(`cycle ${cycle} ready markers`, () =>
      handles.every((pty, index) => pty !== undefined && screenText(pty).includes(`SOAK_READY_${cycle}-${index + 1}`)),
    )

    for (const off of unsubs) off()
    const parked = registry.parkIdle(0)
    if (parked.length !== tabs) throw new Error(`cycle ${cycle}: parked ${parked.length}/${tabs} tabs`)
    await new Promise((resolve) => setTimeout(resolve, 1200))

    handles = keys.map((key) => registry.acquire(key, home, shell))
    unsubs = handles.map((pty) => pty.onData(() => {}))
    await until(`cycle ${cycle} hidden-output markers`, () =>
      handles.every((pty, index) => pty !== undefined && screenText(pty).includes(`SOAK_DELTA_${cycle}-${index + 1}`)),
    )
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    const stats = (await inventory()).stats
    console.log(
      `  cycle ${cycle}/${cycles}: ${stats?.parkRestoreDeltas ?? 0} exact wakes, ${stats?.parkRestoreFallbacks ?? 0} fallback(s), ${Math.round((stats?.ringBytes ?? 0) / 1024)} KB ring`,
    )
  }

  const stats = (await inventory()).stats
  const expected = tabs * cycles
  if ((stats?.parkRestoreDeltas ?? 0) < expected || (stats?.parkRestoreFallbacks ?? 0) > 0) {
    throw new Error(
      `expected ${expected} exact wakes and zero fallbacks; got ${stats?.parkRestoreDeltas ?? 0} exact / ${stats?.parkRestoreFallbacks ?? 0} fallback`,
    )
  }
  console.log(`ok: ${expected} exact wakes, peak client RSS ${Math.round(peakRss / 1024 / 1024)} MB, home ${home}`)
} finally {
  registry.releaseAll()
}
