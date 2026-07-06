export type DiffRowKind = "add" | "del" | "ctx" | "hunk" | "meta"

export interface DiffRow {
  kind: DiffRowKind
  oldLn: number | null
  newLn: number | null
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
    if (line.startsWith("diff --git")) inHunk = false
    if (line === "" || (!inHunk && isMeta(line))) {
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
      rows.push({ kind: "meta", oldLn: null, newLn: null, text: line })
    } else {
      rows.push({ kind: "ctx", oldLn, newLn, text: line })
      oldLn++
      newLn++
    }
  }
  return rows
}
