/**
 * One rigorous, shared parser for `git status --porcelain` and
 * `git diff --numstat` output, with correct C-string unquoting.
 *
 * Why this module exists: the file-tree pane (`tui/panes/filetree/git.ts`)
 * and the sidebar's per-row change chip (`tui/panes/sidebar/worktree-changes.ts`)
 * both parsed the SAME two git formats, with different rigor and neither
 * unquoting paths. Git emits any filename containing a space (porcelain
 * renames), a tab/newline/quote, or a non-ASCII byte as a double-quoted,
 * C-escaped string (e.g. `"a\tb.txt"`, `"\303\274.txt"`). Without unquoting:
 *   - those files render with the wrong (still-escaped) path, and
 *   - a renamed-or-modified file whose name has a space loses its +/- line
 *     counts, because porcelain quotes the path (`"a b.txt"`) while numstat
 *     does NOT (`a b.txt`), so the two never key-match on join.
 * Unquoting BOTH sides to one canonical path is exactly what makes the
 * numstat counts join their porcelain status row.
 *
 * The two consumers want different shapes (the file tree wants per-file
 * rows, the sidebar wants aggregate +/- counts), so this module exposes the
 * lowest common denominator: typed ROWS that preserve the raw `XY` status
 * pair and the canonical (post-rename, unquoted) path. Each consumer derives
 * its own headline/aggregate from those rows.
 *
 * Quoting/rename facts this parser encodes (verified against real git):
 *   - Porcelain rename: `XY orig -> new`. Each side is quoted INDEPENDENTLY
 *     (only when it needs quoting); the ` -> ` separator is literal. Porcelain
 *     quotes a path that merely contains a space.
 *   - Numstat rename: `<a>\t<d>\t<field>`. When NEITHER side needs C-quoting,
 *     git brace-compacts the unchanged segments: `src/{old => new}.txt`. When
 *     EITHER side needs quoting, git drops the braces and emits each side
 *     quoted independently: `"a\tb" => "a\tc"`. Numstat does NOT quote on a
 *     bare space.
 *   - C-quoting escapes `\a \b \t \n \v \f \r \" \\` and otherwise emits a
 *     three-digit OCTAL escape per BYTE (`\303\274` = the UTF-8 bytes of `ü`),
 *     so octal runs must be decoded as bytes, then UTF-8 decoded.
 */

/** One parsed row of `git status --porcelain` (v1). */
export interface PorcelainRow {
  /** Index-side status char (X). May be a space. */
  readonly x: string
  /** Worktree-side status char (Y). May be a space. */
  readonly y: string
  /** Canonical path (post-rename for `R`/`C`), C-unquoted. */
  readonly path: string
  /** Original path for a rename/copy (`R`/`C`), C-unquoted. Absent otherwise. */
  readonly origPath?: string
}

/** One parsed row of `git diff --numstat`. */
export interface NumstatRow {
  /** Canonical path (post-rename), C-unquoted. */
  readonly path: string
  /** Original path for a rename, C-unquoted. Absent otherwise. */
  readonly origPath?: string
  /** Lines added. `null` for a binary file (git emits `-`). */
  readonly added: number | null
  /** Lines deleted. `null` for a binary file (git emits `-`). */
  readonly deleted: number | null
}

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder()

function isOctalDigit(ch: string): boolean {
  return ch >= "0" && ch <= "7"
}

/**
 * Parse one C-quoted token starting at `field[start]` (which MUST be `"`).
 * Returns the unquoted value and `end`, the index just past the closing
 * quote (or the end of input if the quote was unterminated). Octal escapes
 * are decoded as raw bytes and the whole token is UTF-8 decoded, so
 * multi-byte names (`\303\274` → `ü`) round-trip correctly.
 */
function readQuoted(field: string, start: number): { value: string; end: number } {
  const bytes: number[] = []
  let lit = ""
  const flush = () => {
    if (lit.length > 0) {
      for (const b of ENCODER.encode(lit)) bytes.push(b)
      lit = ""
    }
  }
  let i = start + 1 // skip opening quote
  while (i < field.length) {
    const ch = field[i] as string
    if (ch === '"') {
      i++ // consume closing quote
      break
    }
    if (ch === "\\") {
      const n = field[i + 1]
      if (n === undefined) {
        // Trailing backslash with nothing after — keep it literal.
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
            // Unknown escape — keep the escaped character verbatim.
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

/**
 * Unquote a single git path field. If `field` is C-quoted (starts with `"`)
 * it is decoded; otherwise it is returned verbatim (git only quotes when a
 * path needs it). Pure and total — never throws.
 */
export function unquoteGitPath(field: string): string {
  if (field.length === 0 || field[0] !== '"') return field
  return readQuoted(field, 0).value
}

/**
 * Split a rename field (`orig<sep>new`) into its two unquoted sides,
 * respecting independent C-quoting on each side. `sep` is `" -> "` for
 * porcelain or `" => "` for numstat. Returns `null` when no separator is
 * present (i.e. not a rename).
 */
function splitRenameField(field: string, sep: string): { orig: string; neu: string } | null {
  if (field[0] === '"') {
    const left = readQuoted(field, 0)
    if (field.startsWith(sep, left.end)) {
      return { orig: left.value, neu: unquoteGitPath(field.slice(left.end + sep.length)) }
    }
    // Quoted opener but no separator after it — not a rename we can split.
    return null
  }
  const idx = field.indexOf(sep)
  if (idx < 0) return null
  return { orig: field.slice(0, idx), neu: unquoteGitPath(field.slice(idx + sep.length)) }
}

/**
 * Rejoin a brace-compacted rename side (`prefix` + the `{…}` segment + `suffix`).
 *
 * When a rename adds or drops a leading/trailing directory level, git empties
 * ONE brace side — `src/{sub => }/a.txt` (moved up out of `sub/`) or
 * `src/{ => sub}/a.txt` (moved down into `sub/`). Naive `prefix + seg + suffix`
 * then doubles the shared separator: `src/` + `""` + `/a.txt` = `src//a.txt`,
 * which no longer key-matches the porcelain row's `src/a.txt` — the exact join
 * this module exists to keep coherent. Collapse the seam: an empty segment
 * flanked by a `/`-terminated prefix and a `/`-led suffix drops one slash.
 */
function joinBraceParts(prefix: string, seg: string, suffix: string): string {
  if (seg.length === 0 && prefix.endsWith("/") && suffix.startsWith("/")) {
    return prefix + suffix.slice(1)
  }
  return prefix + seg + suffix
}

/**
 * Resolve a `git diff --numstat` path field to its canonical (post-rename,
 * unquoted) path, plus the original path when it is a rename.
 *
 * Handles, in order:
 *   1. Brace-compacted rename `a/{old => new}/b` → new `a/new/b`, orig `a/old/b`.
 *      (Brace compaction only ever appears UNQUOTED — git abandons it the
 *      moment either side needs C-quoting.) An empty brace side (a directory
 *      level added/removed) collapses its doubled separator via {@link joinBraceParts}.
 *   2. Non-brace rename `orig => new` (each side independently C-quoted).
 *   3. Plain path (possibly C-quoted, no rename).
 */
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

/**
 * Parse the raw stdout of `git status --porcelain` (v1) into typed rows.
 *
 * LENIENT by design: every line of the `XY <path>` shape is returned with
 * its raw status pair and canonical unquoted path; branch-header (`## …`),
 * blank, and too-short lines are skipped. Consumers apply their own
 * status whitelist / directory filtering — this parser does not editorialize,
 * so the sidebar can count every entry while the file tree filters to the
 * statuses it colours.
 */
export function parsePorcelainRows(raw: string): PorcelainRow[] {
  const rows: PorcelainRow[] = []
  for (const rawLine of raw.split("\n")) {
    const line = rawLine.replace(/\r$/, "")
    if (line.length < 4) continue // need at least "XY p"
    if (line.startsWith("##")) continue // branch header (`--branch`)
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

/**
 * Parse the raw stdout of `git diff --numstat` into typed rows. Each line is
 * `<added>\t<deleted>\t<field>`; binary files use `-` for the counts (→
 * `null`). Renames (brace-compacted or `=>`) resolve to the canonical
 * post-rename, unquoted path so the counts key by the same path the
 * porcelain `R` row reports. Blank / malformed lines are skipped.
 */
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
