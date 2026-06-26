/**
 * `kobe export [--json|--csv|--format=<json|csv|table>]` — dump the task
 * list to stdout in a machine- or human-readable shape.
 *
 * Read-only and DAEMON-FREE: it loads `~/.kobe/tasks.json` in-process via
 * {@link TaskIndexStore} (the canonical manifest owner — no re-parsing of
 * the file here) and prints. This complements `kobe api list`, which is
 * JSON-only and needs a running daemon; `export` works with the daemon
 * down and adds CSV / aligned-table output for piping into scripts,
 * spreadsheets, or a quick terminal glance.
 *
 * Output contract:
 *   - `--json` (default) → a JSON array of task rows (parses with `jq`).
 *   - `--csv`            → RFC-4180-style CSV with a header row.
 *   - `--format=table`   → aligned, human-readable columns.
 * Mutates nothing; exit 0 on success, exit 2 on a bad flag/format.
 */

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

/** Columns emitted per task, in order. The single source of truth for
 *  every format's field set + header labels. */
const COLUMNS = ["id", "title", "status", "archived", "vendor", "branch", "repo", "worktreePath"] as const
type Column = (typeof COLUMNS)[number]

/** Flatten one task to the exported row (vendor normalized to the default). */
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

/** Parse `kobe export` argv into a single output format (later flag wins). */
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

/** Quote a CSV field per RFC 4180 when it contains a delimiter, quote, or newline. */
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

/**
 * Terminal display width of `s` in cells. Iterates by code point (so astral
 * characters — CJK Extension B, emoji — count once, not as two UTF-16 units),
 * mirroring the code-point awareness of `filetree/rows.ts`'s `truncatePathTail`.
 * East-Asian-wide / fullwidth glyphs and most emoji occupy two cells; combining
 * marks and zero-width formatting characters occupy none; everything else one.
 *
 * kobe is Simplified-Chinese-default, so a CJK task title is the common case —
 * measuring by `String.length` (UTF-16 units) under-counts it and shoves every
 * column to its right out of alignment. Exported for unit tests.
 */
export function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) width += charWidth(ch.codePointAt(0) as number)
  return width
}

/** Cell width of a single Unicode code point: 0 (zero-width), 2 (wide), or 1. */
function charWidth(cp: number): number {
  // Zero-width: combining marks + bidi/format controls + variation selectors.
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical marks extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // combining diacritical marks supplement
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space … LTR/RTL marks
    (cp >= 0x202a && cp <= 0x202e) || // bidi embedding / override
    (cp >= 0x2060 && cp <= 0x2064) || // word joiner … invisible operators
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    cp === 0xfeff // zero-width no-break space (BOM)
  ) {
    return 0
  }
  // Wide: East Asian Wide + Fullwidth + the common emoji / pictograph blocks.
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    cp === 0x2329 ||
    cp === 0x232a || // angle brackets
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … Kangxi … CJK symbols
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana … Katakana … CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi Syllables
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe10 && cp <= 0xfe19) || // vertical forms
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji, symbols & pictographs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Unified Ext B and beyond
  ) {
    return 2
  }
  return 1
}

/** Pad `cell` with trailing spaces to reach `width` terminal cells. */
function padCell(cell: string, width: number): string {
  return cell + " ".repeat(Math.max(0, width - displayWidth(cell)))
}

/** Render aligned columns; widths fit the header and every cell by terminal
 *  display width, so a CJK / wide cell doesn't shove later columns out of line. */
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

/** Build the export text for a given format (exported for unit tests). */
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

  // Read tasks.json directly through its owner — no daemon, no socket.
  const { TaskIndexStore } = await import("../orchestrator/index/store.ts")
  const store = new TaskIndexStore()
  await store.load()
  const tasks = store.list()

  // A table with no rows would print only a header; keep that explicit for humans.
  if (tasks.length === 0 && format === "table") {
    process.stdout.write("no tasks\n")
    return
  }
  process.stdout.write(`${renderExport(tasks, format)}\n`)
}
