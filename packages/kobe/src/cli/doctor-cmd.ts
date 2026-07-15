/** Read-only health report for the PureTUI runtime. */

import { existsSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { KobeDaemonClient } from "@sma1lboy/kobe-daemon/client"
import {
  defaultDaemonLogPath,
  defaultDaemonPidPath,
  defaultDaemonSocketPath,
  defaultPtyHostLogPath,
  defaultPtyHostPidPath,
  defaultPtyHostSocketPath,
} from "@sma1lboy/kobe-daemon/daemon/paths"
import { readPidFile } from "@sma1lboy/kobe-daemon/daemon/server"
import { homeDir, kobeStateDir, kvStatePath } from "../env.ts"
import { SKILL_INSTALL_COMMAND, kobeSkillState } from "../lib/skill-install.ts"
import { CURRENT_VERSION } from "../version.ts"
import { inspectLegacyTmux, legacyTmuxDoctorLines } from "./legacy-tmux.ts"

type PtySessionStatus = { alive?: boolean; parked?: boolean }

type PtyInventory = {
  pid?: number
  rssBytes?: number
  sessions?: PtySessionStatus[]
  stats?: {
    ringBytes?: number
    ringCapacityBytes?: number
    parkedSessions?: number
    parkedScreenBytes?: number
    parkRestoreDeltas?: number
    parkRestoreFallbacks?: number
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function requestIfReachable<T>(socketPath: string, name: "daemon.status" | "pty.list"): Promise<T | null> {
  const client = new KobeDaemonClient(socketPath)
  try {
    return await client.request<T>(name, {})
  } catch {
    return null
  } finally {
    client.close()
  }
}

function fmtDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function describeFile(path: string): string {
  try {
    const stat = statSync(path)
    return `present (${fmtBytes(stat.size)}, modified ${stat.mtime.toISOString()})`
  } catch {
    return "absent"
  }
}

function taskCount(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { tasks?: unknown[] }
    return Array.isArray(parsed.tasks) ? parsed.tasks.length : null
  } catch {
    return null
  }
}

function tailFile(path: string, count: number): string {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-count)
      .join("\n")
  } catch {
    return ""
  }
}

function terminalDoctorLines(): string[] {
  const show = (value: string | undefined): string => (value && value.length > 0 ? value : "(unset)")
  const program = process.env.TERM_PROGRAM
    ? `${process.env.TERM_PROGRAM}${process.env.TERM_PROGRAM_VERSION ? ` v${process.env.TERM_PROGRAM_VERSION}` : ""}`
    : "(unset)"
  return [`terminal: TERM=${show(process.env.TERM)}  TERM_PROGRAM=${program}  COLORTERM=${show(process.env.COLORTERM)}`]
}

async function appendUnavailableProcess(
  out: string[],
  label: string,
  pidPath: string,
  socketPath: string,
): Promise<void> {
  const pid = await readPidFile(pidPath)
  if (pid && isProcessAlive(pid)) out.push(`${label}: ✗ WEDGED — process alive (pid ${pid}) but socket is unreachable`)
  else if (pid) out.push(`${label}: ✗ not running (stale pidfile → pid ${pid} is gone)`)
  else out.push(`${label}: ✗ not running (no pidfile)`)
  if (existsSync(socketPath)) out.push(`          orphan socket file present: ${socketPath}`)
}

export async function runDoctorSubcommand(argv: readonly string[] = []): Promise<void> {
  if (argv.some((arg) => arg === "--help" || arg === "-h" || arg === "help")) {
    process.stdout.write(
      [
        "Usage: kobe doctor",
        "",
        "Read-only diagnosis of the daemon / Hosted PTY / legacy tmux / state. Takes no options.",
        "",
      ].join("\n"),
    )
    return
  }
  const unknown = argv.find((arg) => arg.length > 0)
  if (unknown !== undefined) {
    process.stderr.write(
      `kobe doctor: unexpected argument "${unknown}"\n\nUsage: kobe doctor   (read-only; takes no options)\n`,
    )
    process.exit(2)
  }

  const daemonSocket = defaultDaemonSocketPath()
  const daemonLog = defaultDaemonLogPath()
  const ptySocket = defaultPtyHostSocketPath()
  const ptyLog = defaultPtyHostLogPath()
  const tasksPath = join(kobeStateDir(), "tasks.json")
  const statePath = kvStatePath()
  const out = [
    "kobe doctor",
    `  build:  v${CURRENT_VERSION} (${process.platform} ${process.arch}, bun ${Bun.version})`,
    `  home:   ${homeDir()}`,
    "",
    ...terminalDoctorLines(),
    "",
  ]

  const daemon = await requestIfReachable<Record<string, unknown>>(daemonSocket, "daemon.status")
  if (daemon) {
    const pid = typeof daemon.daemonPid === "number" ? daemon.daemonPid : "?"
    const uptime = typeof daemon.uptimeMs === "number" ? fmtDuration(daemon.uptimeMs) : "?"
    const tasks = typeof daemon.taskCount === "number" ? daemon.taskCount : "?"
    const clients = typeof daemon.attachedClients === "number" ? daemon.attachedClients : "?"
    out.push(`daemon:  ✓ running (pid ${pid}, up ${uptime}, ${tasks} task(s), ${clients} client(s))`)
    const version = typeof daemon.kobeVersion === "string" ? daemon.kobeVersion : undefined
    if (version && version !== CURRENT_VERSION) {
      out.push(`         ⚠ stale build: daemon is v${version}, you launched v${CURRENT_VERSION}`)
      out.push("         → run `kobe daemon restart`, then relaunch kobe")
    } else if (version) out.push(`         build: v${version}`)
  } else {
    await appendUnavailableProcess(out, "daemon ", defaultDaemonPidPath(), daemonSocket)
    const tail = tailFile(daemonLog, 8)
    if (tail) {
      out.push("         last lines of daemon.log:")
      for (const line of tail.split("\n")) out.push(`         │ ${line}`)
    }
  }
  out.push("")

  const inventory = await requestIfReachable<PtyInventory>(ptySocket, "pty.list")
  if (inventory) {
    const sessions = inventory.sessions ?? []
    const parked = inventory.stats?.parkedSessions ?? sessions.filter((session) => session.parked).length
    out.push(
      `pty host: ✓ running (${sessions.length} session(s), ${sessions.filter((session) => session.alive).length} live, ${parked} parked)`,
    )
    if (typeof inventory.pid === "number" && typeof inventory.rssBytes === "number") {
      out.push(`         pid ${inventory.pid}, ${fmtBytes(inventory.rssBytes)} RSS`)
    }
    const stats = inventory.stats
    if (stats && typeof stats.ringBytes === "number" && typeof stats.ringCapacityBytes === "number") {
      out.push(`         ring: ${fmtBytes(stats.ringBytes)} / ${fmtBytes(stats.ringCapacityBytes)}`)
    }
    if (stats && typeof stats.parkedScreenBytes === "number") {
      out.push(`         parked screens: ${fmtBytes(stats.parkedScreenBytes)}`)
    }
    if (stats && typeof stats.parkRestoreDeltas === "number" && typeof stats.parkRestoreFallbacks === "number") {
      out.push(
        `         park wakes: ${stats.parkRestoreDeltas} delta, ${stats.parkRestoreFallbacks} full replay fallback`,
      )
    }
  } else {
    await appendUnavailableProcess(out, "pty host", defaultPtyHostPidPath(), ptySocket)
  }
  out.push("")

  out.push(...legacyTmuxDoctorLines(await inspectLegacyTmux()), "")

  const skill = kobeSkillState()
  if (!skill.installed) {
    out.push("skill:   ✗ kobe agent skill not installed", `         → ${SKILL_INSTALL_COMMAND}`)
  } else if (skill.stale) {
    const installed = skill.installedVersion === null ? "unstamped" : `v${skill.installedVersion}`
    out.push(`skill:   ⚠ kobe agent skill out of date (${installed}; this kobe wants v${skill.currentVersion})`)
    out.push(`         → ${SKILL_INSTALL_COMMAND}`)
  } else out.push(`skill:   ✓ kobe agent skill installed (v${skill.installedVersion})`)
  out.push("")

  const count = taskCount(tasksPath)
  out.push(`tasks.json: ${describeFile(tasksPath)}${count === null ? "" : ` — ${count} task(s)`}`)
  out.push(`state.json: ${describeFile(statePath)}`)
  out.push(`daemon.log: ${describeFile(daemonLog)}`)
  out.push(`pty-host.log: ${describeFile(ptyLog)}`)
  console.log(out.join("\n"))
}
