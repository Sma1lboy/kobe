/**
 * Tiny XML tokenizer for SVG syntax highlighting in the preview pane
 * (KOB-14 stretch). Pure module — no DOM, no tree-sitter, no opentui.
 *
 * Why hand-rolled and not tree-sitter: kobe explicitly avoids dragging
 * opentui's bundled tree-sitter grammar set into the preview pipeline
 * (see notes in `markdown-parser.ts`, `terminal/sgr.ts`). For XML the
 * grammar is small enough that ~80 LOC of regex-based tokenization is
 * less code than a tree-sitter integration would be, and it sidesteps
 * the test-runner / asset-loading concerns the other modules call out.
 *
 * Coverage is "highlighting-grade", not "validation-grade":
 *   - Comments (`<!-- ... -->`)
 *   - CDATA (`<![CDATA[ ... ]]>`)
 *   - Doctype + processing instructions (`<!DOCTYPE …>`, `<?xml …?>`)
 *   - Tag delimiters (`<`, `</`, `>`, `/>`)
 *   - Tag names
 *   - Attribute names and values (both `"…"` and `'…'`)
 *   - Plain text between tags
 *
 * The tokenizer is line-aware: it yields tokens broken at newline
 * boundaries so the caller can render one TUI row per source line
 * (mirroring the rest of the preview pipeline). Multi-line tokens —
 * a long attribute value, a comment, a CDATA block — get split
 * automatically.
 */

export type XmlTokenKind =
  | "tag-delim" // `<`, `</`, `>`, `/>`
  | "tag-name"
  | "attr-name"
  | "attr-eq" // the `=` between attr name and value
  | "attr-value" // including the surrounding quotes
  | "comment"
  | "cdata"
  | "doctype" // DOCTYPE / processing instruction body
  | "text" // text content between tags
  | "whitespace"

export type XmlToken = { readonly kind: XmlTokenKind; readonly text: string }

/**
 * Tokenize `src` into a stream of typed segments. Every byte of input
 * appears in exactly one token (no skipped whitespace, no merged runs
 * across kinds) so the renderer can paint the source verbatim with
 * the type-driven colors.
 */
export function tokenizeXml(src: string): XmlToken[] {
  const out: XmlToken[] = []
  const len = src.length
  let i = 0

  function push(kind: XmlTokenKind, text: string): void {
    if (!text) return
    out.push({ kind, text })
  }

  while (i < len) {
    const ch = src[i]

    if (ch !== "<") {
      // Text content between tags. We accumulate up to the next `<`.
      let j = i
      while (j < len && src[j] !== "<") j += 1
      push("text", src.slice(i, j))
      i = j
      continue
    }

    // We're at a `<` — figure out which markup construct starts here.
    // Order matters: longer prefixes (`<!--`, `<![CDATA[`, `<!DOCTYPE`,
    // `<?xml`) must be tested before the generic `<` tag opener.
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4)
      const stop = end === -1 ? len : end + 3
      push("comment", src.slice(i, stop))
      i = stop
      continue
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9)
      const stop = end === -1 ? len : end + 3
      push("cdata", src.slice(i, stop))
      i = stop
      continue
    }
    if (src.startsWith("<!", i) || src.startsWith("<?", i)) {
      // Processing instruction or DOCTYPE — match up to `?>` or `>`.
      const piEnd = src.indexOf("?>", i + 2)
      const dtEnd = src.indexOf(">", i + 2)
      let stop: number
      if (src.startsWith("<?", i) && piEnd !== -1 && (dtEnd === -1 || piEnd <= dtEnd)) {
        stop = piEnd + 2
      } else if (dtEnd !== -1) {
        stop = dtEnd + 1
      } else {
        stop = len
      }
      push("doctype", src.slice(i, stop))
      i = stop
      continue
    }

    // Regular tag: `<tagname …>` or `</tagname>` or `<tagname/>`.
    // Emit a `<` (or `</`) delim, then the tag name, then walk
    // attributes until `>` or `/>`.
    const isClose = src[i + 1] === "/"
    push("tag-delim", isClose ? "</" : "<")
    i += isClose ? 2 : 1
    // Tag name (letters, digits, ':', '-', '_', '.').
    let j = i
    while (j < len && /[A-Za-z0-9:_\-.]/.test(src[j])) j += 1
    push("tag-name", src.slice(i, j))
    i = j
    // Walk attributes and intra-tag whitespace until close.
    while (i < len) {
      const c = src[i]
      if (c === ">") {
        push("tag-delim", ">")
        i += 1
        break
      }
      if (c === "/" && src[i + 1] === ">") {
        push("tag-delim", "/>")
        i += 2
        break
      }
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        let k = i
        while (k < len && (src[k] === " " || src[k] === "\t" || src[k] === "\n" || src[k] === "\r")) k += 1
        push("whitespace", src.slice(i, k))
        i = k
        continue
      }
      if (c === "=") {
        push("attr-eq", "=")
        i += 1
        continue
      }
      if (c === '"' || c === "'") {
        // Attribute value (including quotes).
        const q = c
        let k = i + 1
        while (k < len && src[k] !== q) k += 1
        const stop = k < len ? k + 1 : len
        push("attr-value", src.slice(i, stop))
        i = stop
        continue
      }
      // Attribute name (letters, digits, ':', '-', '_', '.').
      let k = i
      while (k < len && /[A-Za-z0-9:_\-.]/.test(src[k])) k += 1
      if (k === i) {
        // Unknown byte — emit as text and advance so we don't infinite-
        // loop on malformed input.
        push("text", src[i])
        i += 1
        continue
      }
      push("attr-name", src.slice(i, k))
      i = k
    }
  }

  return out
}

/**
 * Split a token stream at every `\n`, producing a list of lines. Each
 * line is a sub-stream of tokens (`text` parts have the newline trimmed
 * off the end of one row and stripped from the start of the next).
 * Returning at least one empty row keeps the renderer's `For` loop
 * stable on empty input.
 */
export function splitTokensByLine(tokens: readonly XmlToken[]): XmlToken[][] {
  const out: XmlToken[][] = []
  let row: XmlToken[] = []
  for (const tok of tokens) {
    if (!tok.text.includes("\n")) {
      row.push(tok)
      continue
    }
    const parts = tok.text.split("\n")
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i]) row.push({ kind: tok.kind, text: parts[i] })
      if (i < parts.length - 1) {
        out.push(row)
        row = []
      }
    }
  }
  out.push(row)
  return out
}
