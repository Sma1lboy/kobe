export interface PorcelainRow {
  readonly x: string
  readonly y: string
  readonly path: string
  readonly origPath?: string
}

export interface NumstatRow {
  readonly path: string
  readonly origPath?: string
  readonly added: number | null
  readonly deleted: number | null
}

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

function isOctalDigit(ch: string): boolean {
  return ch >= "0" && ch <= "7"
}

function readQuoted(field: string, start: number): { value: string; end: number } {
  const bytes: number[] = []
  let lit = ""
  const flush = () => {
    if (lit.length > 0) {
      for (const b of ENCODER.encode(lit)) bytes.push(b)
      lit = ""
    }
  }
  let i = start + 1
  while (i < field.length) {
    const ch = field[i] as string
    if (ch === '"') {
      i++
      break
    }
    if (ch === "\\") {
      const n = field[i + 1]
      if (n === undefined) {
        lit += "\\"
        i++
        continue
      }
      switch (n) {
        case "a":
          flush()
          bytes.push(0x07)
          i += 2
          break
        case "b":
          flush()
          bytes.push(0x08)
          i += 2
          break
        case "t":
          flush()
          bytes.push(0x09)
          i += 2
          break
        case "n":
          flush()
          bytes.push(0x0a)
          i += 2
          break
        case "v":
          flush()
          bytes.push(0x0b)
          i += 2
          break
        case "f":
          flush()
          bytes.push(0x0c)
          i += 2
          break
        case "r":
          flush()
          bytes.push(0x0d)
          i += 2
          break
        case '"':
          lit += '"'
          i += 2
          break
        case "\\":
          lit += "\\"
          i += 2
          break
        default:
          if (isOctalDigit(n)) {
            let oct = ""
            let j = i + 1
            while (j < field.length && oct.length < 3 && isOctalDigit(field[j] as string)) {
              oct += field[j]
              j++
            }
            flush()
            bytes.push(Number.parseInt(oct, 8) & 0xff)
            i = j
          } else {
            lit += n
            i += 2
          }
          break
      }
    } else {
      lit += ch
      i++
    }
  }
  flush()
  return { value: DECODER.decode(new Uint8Array(bytes)), end: i }
}

export function unquoteGitPath(field: string): string {
  if (field.length === 0 || field[0] !== '"') return field
  return readQuoted(field, 0).value
}

function splitRenameField(field: string, sep: string): { orig: string; neu: string } | null {
  if (field[0] === '"') {
    const left = readQuoted(field, 0)
    if (field.startsWith(sep, left.end)) {
      return { orig: left.value, neu: unquoteGitPath(field.slice(left.end + sep.length)) }
    }
    return null
  }
  const idx = field.indexOf(sep)
  if (idx < 0) return null
  return { orig: field.slice(0, idx), neu: unquoteGitPath(field.slice(idx + sep.length)) }
}

function joinBraceParts(prefix: string, seg: string, suffix: string): string {
  if (seg.length === 0 && prefix.endsWith("/") && suffix.startsWith("/")) {
    return prefix + suffix.slice(1)
  }
  return prefix + seg + suffix
}

function resolveNumstatField(field: string): { path: string; origPath?: string } {
  const open = field.indexOf("{")
  if (open >= 0) {
    const close = field.indexOf("}", open)
    const sep = field.indexOf(" => ", open)
    if (close > open && sep >= 0 && sep < close) {
      const prefix = field.slice(0, open)
      const oldSeg = field.slice(open + 1, sep)
      const newSeg = field.slice(sep + " => ".length, close)
      const suffix = field.slice(close + 1)
      return {
        path: joinBraceParts(prefix, newSeg, suffix),
        origPath: joinBraceParts(prefix, oldSeg, suffix),
      }
    }
  }
  const split = splitRenameField(field, " => ")
  if (split) return { path: split.neu, origPath: split.orig }
  return { path: unquoteGitPath(field) }
}

export function parsePorcelainRows(raw: string): PorcelainRow[] {
  const rows: PorcelainRow[] = []
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line.length < 4) continue
    if (line.startsWith("##")) continue
    const x = line[0] as string
    const y = line[1] as string
    if (line[2] !== " ") continue
    const rest = line.slice(3)
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const split = splitRenameField(rest, " -> ")
      if (split) {
        rows.push({ x, y, path: split.neu, origPath: split.orig })
        continue
      }
    }
    rows.push({ x, y, path: unquoteGitPath(rest) })
  }
  return rows
}

function parseCount(token: string): number | null {
  if (token === "-") return null
  const n = Number.parseInt(token, 10)
  return Number.isNaN(n) ? null : n
}

export function parseNumstatRows(raw: string): NumstatRow[] {
  const rows: NumstatRow[] = []
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line.length === 0) continue
    const tab1 = line.indexOf("\t")
    if (tab1 < 0) continue
    const tab2 = line.indexOf("\t", tab1 + 1)
    if (tab2 < 0) continue
    const field = line.slice(tab2 + 1)
    if (field.length === 0) continue
    const resolved = resolveNumstatField(field)
    if (resolved.path.length === 0) continue
    rows.push({
      path: resolved.path,
      ...(resolved.origPath !== undefined ? { origPath: resolved.origPath } : {}),
      added: parseCount(line.slice(0, tab1)),
      deleted: parseCount(line.slice(tab1 + 1, tab2)),
    })
  }
  return rows
}
