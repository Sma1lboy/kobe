#!/usr/bin/env bun
/**
 * Manage the `bun run dev:sandbox` isolated environment.
 *
 * Unlike `dev-fixture.ts` (which seeds canned tasks/repos for the
 * dev-fake engine), sandbox state is intentionally EMPTY — the whole
 * point is "real engines, empty worktree state" so a worktree-based
 * agent / human can iterate on kobe itself without polluting the
 * production `~/.kobe/tasks.json`.
 *
 * The npm `dev:sandbox` script handles `mkdir -p .dev-sandbox/home`
 * inline (no fixture seeding needed). This script only owns the
 * `--reset` path: stop any sandbox daemon that happens to be alive,
 * then wipe the tree.
 *
 * Why graceful stop matters: if the user has a sandbox TUI open and
 * runs reset, the daemon process keeps the in-memory state and would
 * re-emit it to disk on the next mutation, "resurrecting" the wiped
 * tasks.json. Sending SIGTERM via the pidfile first avoids that race.
 */

import { existsSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const ROOT = resolve(__dirname, "..", ".dev-sandbox")
const PID_PATH = join(ROOT, "home", ".kobe", "daemon.pid")

const reset = process.argv.includes("--reset")

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await sleep(50)
  }
  return !isAlive(pid)
}

async function main(): Promise<void> {
  if (!reset) {
    console.log("usage: bun run dev:sandbox:reset")
    console.log("       (to start a sandbox: `bun run dev:sandbox`)")
    return
  }

  if (existsSync(PID_PATH)) {
    const pidRaw = readFileSync(PID_PATH, "utf8").trim()
    const pid = Number.parseInt(pidRaw, 10)
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM")
        if (!(await waitForExit(pid, 3000))) {
          process.kill(pid, "SIGKILL")
          if (!(await waitForExit(pid, 1000))) {
            console.warn(`dev-sandbox: pid=${pid} is still alive; refusing to wipe ${ROOT}`)
            return
          }
        }
      } catch (err) {
        // ESRCH = no such process; anything else worth noting but not fatal.
        const code = (err as NodeJS.ErrnoException).code
        if (code !== "ESRCH") {
          console.warn(`dev-sandbox: SIGTERM to pid=${pid} failed: ${code ?? String(err)}`)
        }
      }
    }
  }

  if (existsSync(ROOT)) {
    rmSync(ROOT, { recursive: true, force: true })
    console.log(`dev-sandbox: wiped ${ROOT}`)
  } else {
    console.log("dev-sandbox: nothing to reset")
  }
}

await main()
