/**
 * Minimal, SAFE markdown → HTML for the notes preview. Security model: escape
 * ALL HTML first, then emit only our own tags from the escaped text — so user
 * input can never inject markup. Link hrefs are scheme-checked (http/https/
 * relative only; `javascript:` etc. are dropped to plain text). Not a full
 * CommonMark engine — a pragmatic subset (headings, lists, quotes, code,
 * fences, hr, bold/italic/code/links) that covers scratchpad notes.
 *
 * Output is rendered via dangerouslySetInnerHTML, which is safe ONLY because
 * every code path here escapes before composing tags. Keep that invariant.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

/** Allow only http(s) and relative links; everything else renders as text. */
function safeHref(raw: string): string | null {
  const url = raw.trim()
  if (/^https?:\/\//i.test(url)) return url
  if (
    url.startsWith("/") ||
    url.startsWith("#") ||
    url.startsWith("./") ||
    url.startsWith("../")
  ) {
    return url
  }
  return null
}

/** Inline spans on ALREADY-ESCAPED text: code, bold, italic, links. */
function renderInline(escaped: string): string {
  let out = escaped
  // `code` first so its contents aren't re-processed for bold/italic.
  out = out.replace(/`([^`]+)`/g, '<code class="kobe-md-code">$1</code>')
  // [text](url) — url is from escaped text; validate scheme, drop unsafe.
  // Skip the link regex entirely when there's no `]`/`(` to match: its
  // `[^\]]+`/`[^)]+` classes backtrack quadratically on a long run of
  // unmatched `[`, so a bracket-heavy line could otherwise stall the render.
  if (out.includes("]") && out.includes(")"))
    out = out.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, text: string, url: string) => {
        // The URL was HTML-escaped (e.g. &amp;); unescape &amp; for the scheme
        // check and the href, but it's still HTML-safe inside an attribute.
        const href = safeHref(url.replace(/&amp;/g, "&"))
        if (!href) return `${text}(${url})`
        const safe = escapeHtml(href)
        return `<a href="${safe}" target="_blank" rel="noopener noreferrer" class="kobe-md-link">${text}</a>`
      },
    )
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
  return out
}

export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n")
  const html: string[] = []
  let i = 0
  let listType: "ul" | "ol" | null = null

  const closeList = (): void => {
    if (listType) {
      html.push(`</${listType}>`)
      listType = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]

    // Fenced code block ```…```
    if (/^```/.test(line)) {
      closeList()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(escapeHtml(lines[i]))
        i++
      }
      i++ // skip closing fence
      html.push(
        `<pre class="kobe-md-pre"><code>${body.join("\n")}</code></pre>`,
      )
      continue
    }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList()
      html.push('<hr class="kobe-md-hr" />')
      i++
      continue
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      const level = heading[1].length
      html.push(
        `<h${level} class="kobe-md-h">${renderInline(escapeHtml(heading[2]))}</h${level}>`,
      )
      i++
      continue
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      closeList()
      html.push(
        `<blockquote class="kobe-md-quote">${renderInline(escapeHtml(line.replace(/^>\s?/, "")))}</blockquote>`,
      )
      i++
      continue
    }

    // Unordered list item
    const ul = /^\s*[-*]\s+(.*)$/.exec(line)
    if (ul) {
      if (listType !== "ul") {
        closeList()
        html.push('<ul class="kobe-md-ul">')
        listType = "ul"
      }
      html.push(`<li>${renderInline(escapeHtml(ul[1]))}</li>`)
      i++
      continue
    }

    // Ordered list item
    const ol = /^\s*\d+\.\s+(.*)$/.exec(line)
    if (ol) {
      if (listType !== "ol") {
        closeList()
        html.push('<ol class="kobe-md-ol">')
        listType = "ol"
      }
      html.push(`<li>${renderInline(escapeHtml(ol[1]))}</li>`)
      i++
      continue
    }

    // Blank line → list/paragraph break
    if (line.trim() === "") {
      closeList()
      i++
      continue
    }

    // Paragraph: gather consecutive non-blank, non-block lines.
    closeList()
    const para: string[] = [line]
    i++
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,6}\s|>\s?|```|\s*[-*]\s|\s*\d+\.\s|\s*(-{3,}|\*{3,}|_{3,})\s*$)/.test(
        lines[i],
      )
    ) {
      para.push(lines[i])
      i++
    }
    html.push(
      `<p class="kobe-md-p">${renderInline(escapeHtml(para.join(" ")))}</p>`,
    )
  }
  closeList()
  return html.join("\n")
}
