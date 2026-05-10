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

/** Block-level token. The renderer maps these 1:1 to JSX. */
export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: string[] }
  | { kind: "blockquote"; lines: string[] }
  | { kind: "code"; lang: string; lines: string[] }

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
 *   3. Blockquote: contiguous lines starting with `>` (one quote level
 *      only — nested quotes are flattened).
 *   4. Unordered list: contiguous `- ` / `* ` lines.
 *   5. Ordered list: contiguous `1. 2. 3.` lines. The `start` is the
 *      first item's number so `5. 6. 7.` renders from 5, matching
 *      claude-code's `<ol start>` behaviour.
 *   6. Paragraph: everything else. Consecutive non-blank lines that
 *      don't match any of the above join with `\n`.
 *
 * Blank lines separate paragraphs.
 */
export function parseBlocks(src: string): Block[] {
  const lines = src.split("\n")
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
      const items: string[] = []
      while (i < lines.length && ULIST_RE.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(ULIST_RE, ""))
        i++
      }
      blocks.push({ kind: "list", ordered: false, start: 1, items })
      continue
    }
    const olistFirst = OLIST_RE.exec(line)
    if (olistFirst) {
      const start = Number.parseInt(olistFirst[1] ?? "1", 10) || 1
      const items: string[] = []
      while (i < lines.length && OLIST_RE.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(OLIST_RE, ""))
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
      if (/^```/.test(l)) break
      paraLines.push(l)
      i++
    }
    blocks.push({ kind: "paragraph", text: paraLines.join("\n") })
  }
  return blocks
}

/**
 * Tokenize a paragraph (or list item) into inline spans.
 *
 * Recognized markers (in priority order; first match wins per position):
 *
 *   - `` `code` ``        — inline code (no nesting; raw text inside)
 *   - `[text](href)`      — inline link (no nested brackets in text)
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
