/**
 * Pure parser half of the chat-pane markdown renderer.
 *
 * Extracted from `Markdown.tsx` so unit tests can import the parsers
 * directly without dragging in `@opentui/core` (its bundled tree-sitter
 * grammar needs Bun's FFI and crashes vitest's Node worker pool on
 * import — same constraint that put `help-dialog-helpers.ts` next to
 * `help-dialog.tsx`).
 *
 * The renderer side (`Markdown.tsx`) re-exports the types from here
 * so callers see a single import surface.
 */

/** A single list row. `checked` only set for GFM `- [ ]` / `- [x]` syntax. */
export type ListItem = {
  text: string
  checked?: boolean
}

/** Per-column alignment from `:---:` / `---:` markers in the table separator row. */
export type TableAlign = "left" | "center" | "right"

/** Block-level token. The renderer maps these 1:1 to JSX. */
export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "blockquote"; lines: string[] }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "hr" }
  | { kind: "table"; align: TableAlign[]; header: string[]; rows: string[][] }

/** Inline-level token. Used inside paragraphs and list items. */
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; text: string }
  | { kind: "italic"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string }

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const ULIST_RE = /^\s*[-*]\s+/
const OLIST_RE = /^\s*(\d+)\.\s+/
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/
/** Three or more `-`, `*`, or `_` (same char), optionally separated by spaces.
 *  Matches CommonMark thematic break rules; rejects mixed runs like `-*-`. */
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
/** GFM table separator row: `| --- | :---: | ---: |` (pipes optional at edges). */
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/
/** Tasklist marker at the head of a list item's body: `[ ]` / `[x]` / `[X]`. */
const TASK_RE = /^\[([ xX])\]\s+/

/**
 * Split a single table-row line into cell strings.
 *
 * Strips the leading/trailing pipe (both optional in GFM), splits on `|`
 * not preceded by a backslash, and trims each cell. Escaped `\|` survives
 * as a literal pipe inside the cell.
 */
function splitTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\||\|$/g, "")
  const cells: string[] = []
  let buf = ""
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]
    if (ch === "\\" && trimmed[i + 1] === "|") {
      buf += "|"
      i++
      continue
    }
    if (ch === "|") {
      cells.push(buf.trim())
      buf = ""
      continue
    }
    buf += ch ?? ""
  }
  cells.push(buf.trim())
  return cells
}

/** Parse the `:---:` separator row into per-column alignment. */
function parseTableAlign(sep: string): TableAlign[] {
  return splitTableRow(sep).map((c) => {
    const left = c.startsWith(":")
    const right = c.endsWith(":")
    if (left && right) return "center"
    if (right) return "right"
    return "left"
  })
}

/** Strip a leading `[ ]` / `[x]` task marker; returns null if not a tasklist. */
function extractTask(text: string): { checked: boolean; rest: string } | null {
  const m = TASK_RE.exec(text)
  if (!m) return null
  const checked = (m[1] ?? " ") !== " "
  return { checked, rest: text.slice(m[0].length) }
}

/**
 * Split markdown source into block-level tokens.
 *
 * Recognized blocks (in priority order):
 *
 *   1. Fenced code: a line starting with ``` (optionally followed by a
 *      lang ident) opens a code block. Subsequent lines accumulate
 *      until the next ``` line. If EOF arrives without a close, the
 *      block stays open (streaming case — we still render what we
 *      have).
 *   2. Heading: 1–6 leading `#` followed by a space and the heading
 *      text. Only ATX style; setext (`===`/`---` underline) is rare in
 *      assistant output.
 *   3. Horizontal rule: 3+ of `-` / `*` / `_` on a line of their own.
 *   4. Table: a `| h | h |` line followed by a `|---|---|` separator —
 *      both required, otherwise it's just a paragraph with pipes.
 *   5. Blockquote: contiguous lines starting with `>` (one quote level
 *      only — nested quotes are flattened).
 *   6. Unordered list: contiguous `- ` / `* ` lines. List items whose
 *      body starts with `[ ]` / `[x]` are tagged as task-list rows.
 *   7. Ordered list: contiguous `1. 2. 3.` lines. The `start` is the
 *      first item's number so `5. 6. 7.` renders from 5, matching
 *      claude-code's `<ol start>` behaviour.
 *   8. Paragraph: everything else. Consecutive non-blank lines that
 *      don't match any of the above join with `\n`.
 *
 * Blank lines separate paragraphs.
 */
export function parseBlocks(src: string): Block[] {
  // Normalize CRLF / lone CR first. GitHub release bodies (the update
  // dialog's "What's new" source) come back with `\r\n` endings; a
  // stray `\r` left on a line renders as a garbage glyph in opentui's
  // text layer. Strip it once here so every block/inline pass downstream
  // sees clean `\n`-delimited text.
  const lines = src.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ""
    // Fenced code block.
    const fence = /^```(\w*)\s*$/.exec(line)
    if (fence) {
      const lang = fence[1] ?? ""
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i] ?? "")) {
        codeLines.push(lines[i] ?? "")
        i++
      }
      if (i < lines.length) i++
      blocks.push({ kind: "code", lang, lines: codeLines })
      continue
    }
    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = Math.min(6, heading[1]!.length) as 1 | 2 | 3 | 4 | 5 | 6
      blocks.push({ kind: "heading", level, text: (heading[2] ?? "").trim() })
      i++
      continue
    }
    if (HR_RE.test(line)) {
      blocks.push({ kind: "hr" })
      i++
      continue
    }
    // Table: `| ... |` with the next line a `|---|---|` separator. We
    // require the separator to fire — a paragraph that happens to
    // contain a `|` should not be confused with a one-row table.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1] ?? "")) {
      const header = splitTableRow(line)
      const align = parseTableAlign(lines[i + 1] ?? "")
      // Pad align to the header column count (GFM: missing cells = left).
      while (align.length < header.length) align.push("left")
      i += 2
      const rows: string[][] = []
      while (i < lines.length) {
        const l = lines[i] ?? ""
        if (l.trim() === "" || !l.includes("|")) break
        const cells = splitTableRow(l)
        // Normalize row width to header width (extra cells dropped, missing
        // cells padded with empty string so column indexing stays stable).
        if (cells.length > header.length) cells.length = header.length
        while (cells.length < header.length) cells.push("")
        rows.push(cells)
        i++
      }
      blocks.push({ kind: "table", align, header, rows })
      continue
    }
    if (BLOCKQUOTE_RE.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length) {
        const m = BLOCKQUOTE_RE.exec(lines[i] ?? "")
        if (!m) break
        quoteLines.push(m[1] ?? "")
        i++
      }
      blocks.push({ kind: "blockquote", lines: quoteLines })
      continue
    }
    if (ULIST_RE.test(line)) {
      const items: ListItem[] = []
      while (i < lines.length && ULIST_RE.test(lines[i] ?? "")) {
        const body = (lines[i] ?? "").replace(ULIST_RE, "")
        const task = extractTask(body)
        items.push(task ? { text: task.rest, checked: task.checked } : { text: body })
        i++
      }
      blocks.push({ kind: "list", ordered: false, start: 1, items })
      continue
    }
    const olistFirst = OLIST_RE.exec(line)
    if (olistFirst) {
      const start = Number.parseInt(olistFirst[1] ?? "1", 10) || 1
      const items: ListItem[] = []
      while (i < lines.length && OLIST_RE.test(lines[i] ?? "")) {
        items.push({ text: (lines[i] ?? "").replace(OLIST_RE, "") })
        i++
      }
      blocks.push({ kind: "list", ordered: true, start, items })
      continue
    }
    if (line.trim() === "") {
      i++
      continue
    }
    const paraLines: string[] = []
    while (i < lines.length) {
      const l = lines[i] ?? ""
      if (l.trim() === "") break
      if (ULIST_RE.test(l)) break
      if (OLIST_RE.test(l)) break
      if (HEADING_RE.test(l)) break
      if (BLOCKQUOTE_RE.test(l)) break
      if (HR_RE.test(l)) break
      if (/^```/.test(l)) break
      paraLines.push(l)
      i++
    }
    blocks.push({ kind: "paragraph", text: paraLines.join("\n") })
  }
  return blocks
}

/** Bare URL autolink — http(s) only. Stops at whitespace, closing brackets,
 *  and trailing punctuation that's almost never part of a URL. We're
 *  deliberately permissive about what's IN the URL and strict only about
 *  what TERMINATES it; the model's job is to write valid URLs. */
const BARE_URL_RE = /^https?:\/\/[^\s<>()[\]{}'"`]+/
/** Trailing chars stripped from autolinked URLs (sentence punctuation that
 *  isn't part of the URL but ended up adjacent to it). */
const URL_TRAILING_PUNCT = /[.,!?;:]+$/

/**
 * Tokenize a paragraph (or list item) into inline spans.
 *
 * Recognized markers (in priority order; first match wins per position):
 *
 *   - `` `code` ``        — inline code (no nesting; raw text inside)
 *   - `[text](href)`      — inline link (no nested brackets in text)
 *   - `https://...`       — bare URL autolink (http/https only)
 *   - `**bold**`          — bold (no nested asterisks expected)
 *   - `*italic*` or `_italic_` — italic (no nested underscores)
 *
 * Unmatched / mismatched markers fall back to plain text — better to
 * render Claude's literal `**` than to throw or hide the content.
 */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let buf = ""
  let i = 0
  const flushBuf = () => {
    if (buf.length > 0) {
      out.push({ kind: "text", text: buf })
      buf = ""
    }
  }
  while (i < src.length) {
    const ch = src[i]
    if (ch === "`") {
      const end = src.indexOf("`", i + 1)
      if (end > i) {
        flushBuf()
        out.push({ kind: "code", text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (ch === "[") {
      const closeBracket = src.indexOf("]", i + 1)
      if (closeBracket > i && src[closeBracket + 1] === "(") {
        const closeParen = src.indexOf(")", closeBracket + 2)
        if (closeParen > closeBracket + 1) {
          const linkText = src.slice(i + 1, closeBracket)
          const href = src.slice(closeBracket + 2, closeParen)
          // Reject empty href and obvious non-link patterns (whitespace
          // in href = almost certainly not a real URL).
          if (href.length > 0 && !/\s/.test(href)) {
            flushBuf()
            out.push({ kind: "link", text: linkText, href })
            i = closeParen + 1
            continue
          }
        }
      }
    }
    // Bare URL autolink — only fires at a word boundary so "foo:https"
    // inside a token doesn't trigger. Cheap check: previous char is start
    // of input or a non-URL char.
    if ((ch === "h" || ch === "H") && (i === 0 || /[\s(<]/.test(src[i - 1] ?? ""))) {
      const m = BARE_URL_RE.exec(src.slice(i))
      if (m) {
        let url = m[0]
        // Trim trailing sentence punctuation so "see https://x.io." links
        // to https://x.io and leaves the period as text.
        const trail = URL_TRAILING_PUNCT.exec(url)
        let trailingPunct = ""
        if (trail) {
          trailingPunct = trail[0]
          url = url.slice(0, url.length - trailingPunct.length)
        }
        flushBuf()
        out.push({ kind: "link", text: url, href: url })
        if (trailingPunct) buf += trailingPunct
        i += m[0].length
        continue
      }
    }
    if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2)
      if (end > i + 1) {
        flushBuf()
        out.push({ kind: "bold", text: src.slice(i + 2, end) })
        i = end + 2
        continue
      }
    }
    if (ch === "*" || ch === "_") {
      const end = src.indexOf(ch, i + 1)
      if (end > i && /\S/.test(src.slice(i + 1, end))) {
        flushBuf()
        out.push({ kind: "italic", text: src.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    buf += ch
    i++
  }
  flushBuf()
  return out
}

/**
 * Render an inline token list back to its plain-text projection — strips
 * all markup and link decoration. Used by the table renderer to compute
 * column widths from how content will *display*, not how it's authored
 * (`**bold**` displays as 4 chars, not 8).
 */
export function inlinePlainText(tokens: Inline[]): string {
  let out = ""
  for (const t of tokens) {
    if (t.kind === "link") {
      // Display: "text (href)" if they differ, else just href. Mirrors
      // InlineSpans's render branch in Markdown.tsx.
      out += t.text.length > 0 && t.text !== t.href ? `${t.text} (${t.href})` : t.href
      continue
    }
    if (t.kind === "code") {
      // Inline code renders with surrounding backticks (`x`).
      out += `\`${t.text}\``
      continue
    }
    out += t.text
  }
  return out
}
