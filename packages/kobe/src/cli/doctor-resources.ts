import { KOBE_TMUX_SOCKET, runTmuxCapturing, tmuxAvailable } from "../tmux/client.ts"

interface ProcessRow {
  pid: number
  pgid: number
  rssKb: number
  comm: string
}

export function parsePsRows(psOutput: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of psOutput.split("\n").slice(1)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [pid, pgid, rss, ...commParts] = trimmed.split(/\s+/)
    const pidN = Number.parseInt(pid ?? "", 10)
    const pgidN = Number.parseInt(pgid ?? "", 10)
    const rssN = Number.parseInt(rss ?? "", 10)
    if (!Number.isFinite(pidN) || !Number.isFinite(pgidN) || !Number.isFinite(rssN) || commParts.length === 0) continue
    rows.push({ pid: pidN, pgid: pgidN, rssKb: rssN, comm: commParts.join(" ") })
  }
  return rows
}

export function paneProcessGroups(rows: readonly ProcessRow[], panePids: readonly number[]): ProcessRow[] {
  const groups = new Set(panePids)
  return rows.filter((r) => groups.has(r.pgid))
}

async function listPanePids(): Promise<number[]> {
  const { code, stdout } = await runTmuxCapturing(["list-panes", "-a", "-F", "#{pane_pid}"])
  if (code !== 0) return []
  return stdout
    .split("\n")
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 1)
}

async function psSnapshot(): Promise<ProcessRow[]> {
  const proc = Bun.spawn(["ps", "-axo", "pid,pgid,rss,comm"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const [text] = await Promise.all([new Response(proc.stdout).text().catch(() => ""), proc.exited])
  return parsePsRows(text)
}

export async function resourceDoctorLines(): Promise<string[]> {
  if (!(await tmuxAvailable())) return ["resources: tmux not installed — no kobe sessions to measure"]
  const panePids = await listPanePids()
  if (panePids.length === 0) return [`resources: 0 process(es) on \`${KOBE_TMUX_SOCKET}\``]

  const rows = paneProcessGroups(await psSnapshot(), panePids)
  const totalMb = rows.reduce((sum, r) => sum + r.rssKb, 0) / 1024
  const byComm = new Map<string, { count: number; kb: number }>()
  for (const r of rows) {
    const entry = byComm.get(r.comm) ?? { count: 0, kb: 0 }
    entry.count++
    entry.kb += r.rssKb
    byComm.set(r.comm, entry)
  }

  const lines = [
    `resources: ${rows.length} process(es) across ${panePids.length} pane(s) on \`${KOBE_TMUX_SOCKET}\`, ${totalMb.toFixed(1)} MB RSS total`,
  ]
  for (const [comm, { count, kb }] of [...byComm].sort((a, b) => b[1].kb - a[1].kb)) {
    lines.push(`           ${comm}: ${count} proc, ${(kb / 1024).toFixed(1)} MB`)
  }
  return lines
}
