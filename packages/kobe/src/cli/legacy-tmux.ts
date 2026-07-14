/** Read-only diagnosis and reset-time cleanup for pre-v0.8 tmux sessions. */

export const LEGACY_TMUX_SOCKET = "kobe"

interface CommandResult {
  code: number
  stdout: string
  stderr: string
  missing: boolean
}

export interface LegacyProcessRow {
  pid: number
  pgid: number
  rssKb: number
  command: string
}

export interface LegacyTmuxReport {
  available: boolean
  version: string | null
  sessions: string[]
  panePids: number[]
  processes: LegacyProcessRow[]
  error: string | null
}

export interface LegacyTmuxStopResult {
  status: "absent" | "stopped" | "failed"
  sessions: number
  signalledGroups: number
  error?: string
}

async function run(argv: readonly string[]): Promise<CommandResult> {
  try {
    const proc = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
      proc.exited,
    ])
    return { code, stdout, stderr, missing: false }
  } catch (error) {
    const systemError = error as NodeJS.ErrnoException
    return {
      code: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      missing: systemError.code === "ENOENT",
    }
  }
}

async function runTmux(socket: string, args: readonly string[]): Promise<CommandResult> {
  return run(["tmux", "-L", socket, ...args])
}

function commandFailure(label: string, result: CommandResult): string {
  return `${label} failed: ${result.stderr.trim() || `exit ${result.code}`}`
}

function isMissingServer(result: CommandResult): boolean {
  return /no server running|failed to connect to server|no sessions/i.test(`${result.stdout}\n${result.stderr}`)
}

function parsePositiveInts(output: string): number[] {
  return output
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 1)
}

export function parseLegacyPsRows(output: string): LegacyProcessRow[] {
  const rows: LegacyProcessRow[] = []
  for (const line of output.split("\n").slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 4) continue
    const pid = Number.parseInt(parts[0] ?? "", 10)
    const pgid = Number.parseInt(parts[1] ?? "", 10)
    const rssKb = Number.parseInt(parts[2] ?? "", 10)
    if (!Number.isFinite(pid) || !Number.isFinite(pgid) || !Number.isFinite(rssKb)) continue
    rows.push({ pid, pgid, rssKb, command: parts.slice(3).join(" ") })
  }
  return rows
}

export function legacyPaneProcesses(
  rows: readonly LegacyProcessRow[],
  panePids: readonly number[],
): LegacyProcessRow[] {
  const groups = new Set(panePids)
  return rows.filter((row) => groups.has(row.pgid))
}

function emptyReport(available: boolean, version: string | null, error: string | null = null): LegacyTmuxReport {
  return { available, version, sessions: [], panePids: [], processes: [], error }
}

export async function inspectLegacyTmux(socket: string = LEGACY_TMUX_SOCKET): Promise<LegacyTmuxReport> {
  const versionResult = await run(["tmux", "-V"])
  if (versionResult.missing) return emptyReport(false, null)
  if (versionResult.code !== 0) return emptyReport(true, null, commandFailure("tmux -V", versionResult))

  const version = versionResult.stdout.trim() || null
  const sessionsResult = await runTmux(socket, ["list-sessions", "-F", "#{session_name}"])
  if (sessionsResult.code !== 0) {
    if (isMissingServer(sessionsResult)) return emptyReport(true, version)
    return emptyReport(true, version, commandFailure("tmux list-sessions", sessionsResult))
  }

  const sessions = sessionsResult.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  if (sessions.length === 0) return emptyReport(true, version)

  const panesResult = await runTmux(socket, ["list-panes", "-a", "-F", "#{pane_pid}"])
  if (panesResult.code !== 0) {
    return { ...emptyReport(true, version, commandFailure("tmux list-panes", panesResult)), sessions }
  }
  const panePids = parsePositiveInts(panesResult.stdout)
  if (panePids.length === 0) {
    return { ...emptyReport(true, version, "tmux reported live sessions but no pane process groups"), sessions }
  }

  const psResult = await run(["ps", "-axo", "pid,pgid,rss,comm"])
  if (psResult.code !== 0) {
    return { available: true, version, sessions, panePids, processes: [], error: commandFailure("ps", psResult) }
  }
  return {
    available: true,
    version,
    sessions,
    panePids,
    processes: legacyPaneProcesses(parseLegacyPsRows(psResult.stdout), panePids),
    error: null,
  }
}

export function legacyTmuxDoctorLines(report: LegacyTmuxReport, socket: string = LEGACY_TMUX_SOCKET): string[] {
  if (report.error) return [`legacy tmux: ✗ inspection failed — ${report.error}`]
  if (!report.available) return ["legacy tmux: not installed — no pre-v0.8 sessions to inspect"]

  const version = report.version ?? "tmux (version unknown)"
  if (report.sessions.length === 0) return [`legacy tmux: ${version} — no sessions on \`${socket}\``]

  const totalMb = report.processes.reduce((sum, row) => sum + row.rssKb, 0) / 1024
  const grouped = new Map<string, { count: number; rssKb: number }>()
  for (const row of report.processes) {
    const item = grouped.get(row.command) ?? { count: 0, rssKb: 0 }
    item.count++
    item.rssKb += row.rssKb
    grouped.set(row.command, item)
  }

  const lines = [
    `legacy tmux: ⚠ ${version} — ${report.sessions.length} pre-v0.8 session(s) on \`${socket}\``,
    `             ${report.processes.length} process(es) across ${report.panePids.length} pane(s), ${totalMb.toFixed(1)} MB RSS total`,
  ]
  for (const [command, item] of [...grouped].sort((a, b) => b[1].rssKb - a[1].rssKb)) {
    lines.push(`             ${command}: ${item.count} proc, ${(item.rssKb / 1024).toFixed(1)} MB`)
  }
  lines.push("             → run `kobe reset` to stop this retired runtime safely")
  return lines
}

async function ownProcessGroup(): Promise<{ pgid: number | null; error: string | null }> {
  const result = await run(["ps", "-o", "pgid=", "-p", String(process.pid)])
  if (result.code !== 0) return { pgid: null, error: commandFailure("ps current process group", result) }
  const pgid = Number.parseInt(result.stdout.trim(), 10)
  if (!Number.isFinite(pgid) || pgid <= 1) return { pgid: null, error: "unable to determine current process group" }
  return { pgid, error: null }
}

export async function stopLegacyTmux(socket: string = LEGACY_TMUX_SOCKET): Promise<LegacyTmuxStopResult> {
  const report = await inspectLegacyTmux(socket)
  if (report.error)
    return { status: "failed", sessions: report.sessions.length, signalledGroups: 0, error: report.error }
  if (!report.available || report.sessions.length === 0) {
    return { status: "absent", sessions: 0, signalledGroups: 0 }
  }

  const ownGroup = await ownProcessGroup()
  if (ownGroup.error) {
    return { status: "failed", sessions: report.sessions.length, signalledGroups: 0, error: ownGroup.error }
  }

  let signalledGroups = 0
  for (const pgid of new Set(report.panePids)) {
    if (pgid === ownGroup.pgid) continue
    try {
      process.kill(-pgid, "SIGTERM")
      signalledGroups++
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") continue
      return {
        status: "failed",
        sessions: report.sessions.length,
        signalledGroups,
        error: `failed to SIGTERM pane group ${pgid}: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  const result = await runTmux(socket, ["kill-server"])
  if (result.code === 0) return { status: "stopped", sessions: report.sessions.length, signalledGroups }

  const remaining = await inspectLegacyTmux(socket)
  if (!remaining.error && remaining.sessions.length === 0) {
    return { status: "stopped", sessions: report.sessions.length, signalledGroups }
  }
  return {
    status: "failed",
    sessions: report.sessions.length,
    signalledGroups,
    error: remaining.error ?? (result.stderr.trim() || `tmux exited ${result.code}`),
  }
}
