/** Reset daemon and Hosted PTY state without touching git worktrees. */

import { readFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { errorMessage } from "@/lib/error-message"
import { stopDaemonProcess } from "@sma1lboy/kobe-daemon/daemon/lifecycle"
import {
  defaultDaemonPidPath,
  defaultDaemonSocketPath,
  defaultPtyHostPidPath,
  defaultPtyHostSocketPath,
} from "@sma1lboy/kobe-daemon/daemon/paths"
import { kobeStateDir, kvStatePath } from "../env.ts"
import { stopLegacyTmux } from "./legacy-tmux.ts"
import { stampResetGate } from "./reset-gate.ts"

function printUsage(out: Pick<typeof process.stderr, "write">): void {
  out.write(
    [
      "Usage: kobe reset [--hard] [--yes]",
      "",
      "Recover a wedged install: stop the daemon, Hosted PTY host, and any pre-v0.8 tmux sessions.",
      "This ends background terminal and engine sessions; the next launch starts fresh.",
      "Never touches your git worktrees.",
      "",
      "Options:",
      "  --hard        Also wipe the task index + UI state",
      "  -y, --yes     Skip the interactive confirmation",
      "  -h, --help    Print this help",
      "",
    ].join("\n"),
  )
}

function taskCount(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { tasks?: unknown[] }
    return Array.isArray(parsed.tasks) ? parsed.tasks.length : null
  } catch {
    return null
  }
}

async function confirmTty(prompt: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolve) => readline.question(prompt, resolve))
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    readline.close()
  }
}

async function removeStateFile(path: string, label: string): Promise<void> {
  try {
    await unlink(path)
    console.log(`  removed ${label} (${path})`)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") console.log(`  ${label}: already absent`)
    else throw new Error(`failed to remove ${label} (${path}): ${errorMessage(err)}`)
  }
}

export async function runResetSubcommand(argv: readonly string[]): Promise<void> {
  if (argv.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    printUsage(process.stdout)
    return
  }
  const known = new Set(["--hard", "--yes", "-y"])
  const unknown = argv.find((arg) => !known.has(arg))
  if (unknown !== undefined) {
    process.stderr.write(`kobe reset: unknown argument "${unknown}"\n\n`)
    printUsage(process.stderr)
    process.exit(2)
  }

  const hard = argv.includes("--hard")
  const yes = argv.includes("--yes") || argv.includes("-y")
  const daemonSocket = defaultDaemonSocketPath()
  const tasksPath = join(kobeStateDir(), "tasks.json")
  const statePath = kvStatePath()

  console.log("kobe reset will:")
  console.log("  • stop the kobe daemon (graceful → SIGTERM → SIGKILL)")
  console.log(`  • remove its socket + pidfile (${daemonSocket})`)
  console.log("  • stop the standalone Hosted PTY host and all background terminal/engine sessions")
  console.log("  • stop any pre-v0.8 tmux sessions after SIGTERM-ing their pane process groups")
  if (hard) {
    const count = taskCount(tasksPath)
    console.log(`  • DELETE the task index${count === null ? "" : ` (${count} task(s))`} — ${tasksPath}`)
    console.log(`  • DELETE the UI state — ${statePath}`)
  }
  console.log("  • NOT touch your git worktrees under ~/.kobe/worktrees/ or legacy repo-local roots")
  if (!hard) console.log("  (your task list & worktrees are kept — add --hard to also wipe task and UI state)")

  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log("\nre-run with --yes to proceed (no interactive terminal for a y/N prompt)")
      return
    }
    const confirmed = await confirmTty(
      hard ? "\nStop runtimes and wipe task/UI state? [y/N] " : "\nStop runtimes? [y/N] ",
    )
    if (!confirmed) {
      console.log("aborted — nothing changed")
      return
    }
  }

  console.log("")
  const daemon = await stopDaemonProcess(daemonSocket, defaultDaemonPidPath())
  console.log(
    daemon.method === "absent"
      ? "  daemon: was not running (cleared any stale socket/pidfile)"
      : `  daemon: stopped via ${daemon.method}${daemon.pid ? ` (pid ${daemon.pid})` : ""}`,
  )

  const ptyHost = await stopDaemonProcess(defaultPtyHostSocketPath(), defaultPtyHostPidPath())
  console.log(
    ptyHost.method === "absent"
      ? "  pty host: was not running (cleared any stale socket/pidfile)"
      : `  pty host: stopped via ${ptyHost.method}${ptyHost.pid ? ` (pid ${ptyHost.pid})` : ""}`,
  )

  const legacyTmux = await stopLegacyTmux()
  if (legacyTmux.status === "failed") {
    console.error(`  legacy tmux: cleanup failed — ${legacyTmux.error ?? "unknown error"}`)
    process.exitCode = 1
    return
  }
  console.log(
    legacyTmux.status === "absent"
      ? "  legacy tmux: no pre-v0.8 sessions found"
      : `  legacy tmux: stopped ${legacyTmux.sessions} session(s) after signalling ${legacyTmux.signalledGroups} pane group(s)`,
  )

  if (hard) {
    await removeStateFile(tasksPath, "task index")
    await removeStateFile(statePath, "UI state")
  } else stampResetGate()

  console.log("\nkobe: reset complete. Relaunch kobe to start fresh.")
}
