import type { Task } from "../types/task.ts"
import { DEFAULT_TASK_VENDOR } from "../types/task.ts"

type ExportFormat = "json" | "csv" | "table"

const EXPORT_USAGE = [
  "Usage: kobe export [--json | --csv | --format <json|csv|table>]",
  "",
  "Print the task list (from ~/.kobe/tasks.json) to stdout. Read-only and",
  "daemon-free — works with the kobe daemon down.",
  "",
  "Options:",
  "  --json                  JSON array of tasks (default)",
  "  --csv                   CSV with a header row",
  "  --format <fmt>          One of: json, csv, table",
  "  -h, --help              Print this help",
  "",
].join("\n")

const COLUMNS = ["id", "title", "status", "archived", "vendor", "branch", "repo", "worktreePath"] as const
type Column = (typeof COLUMNS)[number]

function toRow(task: Task): Record<Column, string> {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    archived: String(task.archived),
    vendor: task.vendor ?? DEFAULT_TASK_VENDOR,
    branch: task.branch,
    repo: task.repo,
    worktreePath: task.worktreePath,
  }
}

function usageError(message: string): never {
  process.stderr.write(`kobe export: ${message}\n\n${EXPORT_USAGE}\n`)
  process.exit(2)
}

function parseFormat(args: readonly string[]): ExportFormat {
  let format: ExportFormat = "json"
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === "--json") format = "json"
    else if (a === "--csv") format = "csv"
    else if (a === "--format") {
      const v = args[++i]
      if (v === undefined) usageError("--format requires a value (json, csv, or table)")
      format = coerceFormat(v)
    } else if (a.startsWith("--format=")) {
      format = coerceFormat(a.slice("--format=".length))
    } else {
      usageError(`unexpected argument "${a}"`)
    }
  }
  return format
}

function coerceFormat(value: string): ExportFormat {
  if (value === "json" || value === "csv" || value === "table") return value
  usageError(`unknown format "${value}" (expected json, csv, or table)`)
}

function csvCell(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

function renderCsv(rows: readonly Record<Column, string>[]): string {
  const lines = [COLUMNS.join(",")]
  for (const row of rows) {
    lines.push(COLUMNS.map((c) => csvCell(row[c])).join(","))
  }
  return lines.join("\n")
}

export function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) width += charWidth(ch.codePointAt(0) as number)
  return width
}

function charWidth(cp: number): number {
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2060 && cp <= 0x2064) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    cp === 0xfeff
  ) {
    return 0
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

function padCell(cell: string, width: number): string {
  return cell + " ".repeat(Math.max(0, width - displayWidth(cell)))
}

function renderTable(rows: readonly Record<Column, string>[]): string {
  const widths = {} as Record<Column, number>
  for (const c of COLUMNS) widths[c] = Math.max(displayWidth(c), ...rows.map((r) => displayWidth(r[c])))
  const line = (cells: Record<Column, string>) =>
    COLUMNS.map((c) => padCell(cells[c], widths[c]))
      .join("  ")
      .trimEnd()
  const header = {} as Record<Column, string>
  for (const c of COLUMNS) header[c] = c
  return [line(header), ...rows.map(line)].join("\n")
}

export function renderExport(tasks: readonly Task[], format: ExportFormat): string {
  const rows = tasks.map(toRow)
  if (format === "json") return JSON.stringify(rows, null, 2)
  if (format === "csv") return renderCsv(rows)
  return renderTable(rows)
}

export async function runExportSubcommand(args: readonly string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    process.stdout.write(`${EXPORT_USAGE}\n`)
    return
  }
  const format = parseFormat(args)

  const { TaskIndexStore } = await import("../orchestrator/index/store.ts")
  const store = new TaskIndexStore()
  await store.load()
  const tasks = store.list()

  if (tasks.length === 0 && format === "table") {
    process.stdout.write("no tasks\n")
    return
  }
  process.stdout.write(`${renderExport(tasks, format)}\n`)
}
