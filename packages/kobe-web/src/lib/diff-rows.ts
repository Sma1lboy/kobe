/**
 * Parse a unified-diff patch into rows with computed old/new line numbers,
 * so the diff view can render a proper line-number gutter instead of raw
 * `+`/`-` lines. Pure + tested; the hunk-header math is the load-bearing bit.
 */

export type DiffRowKind = "add" | "del" | "ctx" | "hunk" | "meta"

export interface DiffRow {
  kind: DiffRowKind
  /** Old-file line number, or null (added / hunk / meta rows). */
  oldLn: number | null
  /** New-file line number, or null (removed / hunk / meta rows). */
  newLn: number | null
  /** The raw line text (including its leading +/-/space marker). */
  text: string
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

const META_PREFIXES = [
  "diff --git",
  "index ",
  "--- ",
  "+++ ",
  "new file",
  "deleted file",
  "rename ",
  "similarity ",
  "copy ",
  "\\ No newline",
  "Binary files",
]

function isMeta(line: string): boolean {
  return META_PREFIXES.some((p) => line.startsWith(p))
}

/** Count added/removed lines in a unified-diff patch (excludes the `+++`/`---`
 *  file-header lines, which a naive `+`/`-` count would wrongly include). */
export function diffStat(patch: string): { added: number; deleted: number } {
  let added = 0
  let deleted = 0
  for (const row of parseDiffRows(patch)) {
    if (row.kind === "add") added++
    else if (row.kind === "del") deleted++
  }
  return { added, deleted }
}

export function parseDiffRows(patch: string): DiffRow[] {
  const lines = patch.replace(/\n$/, "").split("\n")
  const rows: DiffRow[] = []
  let oldLn = 0
  let newLn = 0
  let inHunk = false

  for (const line of lines) {
    const hunk = HUNK_RE.exec(line)
    if (hunk) {
      oldLn = Number.parseInt(hunk[1], 10)
      newLn = Number.parseInt(hunk[2], 10)
      inHunk = true
      rows.push({ kind: "hunk", oldLn: null, newLn: null, text: line })
      continue
    }
    // Meta lines (file headers) only appear OUTSIDE a hunk body; a "---"/"+++"
    // inside a hunk would be content, but those headers always precede the
    // first @@, so gate on inHunk to avoid mis-tagging a real "+++" content line.
    if (!inHunk && (isMeta(line) || line === "")) {
      rows.push({ kind: "meta", oldLn: null, newLn: null, text: line })
      continue
    }
    const marker = line[0]
    if (marker === "+") {
      rows.push({ kind: "add", oldLn: null, newLn, text: line })
      newLn++
    } else if (marker === "-") {
      rows.push({ kind: "del", oldLn, newLn: null, text: line })
      oldLn++
    } else if (isMeta(line)) {
      // A meta line that slipped in mid-stream (e.g. "\ No newline").
      rows.push({ kind: "meta", oldLn: null, newLn: null, text: line })
    } else {
      // Context line (leading space) or a bare line — advances both sides.
      rows.push({ kind: "ctx", oldLn, newLn, text: line })
      oldLn++
      newLn++
    }
  }
  return rows
}
