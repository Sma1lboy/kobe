function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

const ISSUE_ASSET_SRC =
  /^\/api\/issue-assets\/[a-f0-9]{16}\/[A-Za-z0-9_-]+\.[a-z0-9]+$/

function safeImageSrc(raw: string): string | null {
  const url = raw.trim()
  return ISSUE_ASSET_SRC.test(url) ? url : null
}

function safeHref(raw: string): string | null {
  const url = raw.trim()
  if (/^https?:\/\//i.test(url)) return url
  if (url.startsWith("//")) return null
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

function transformSpans(s: string): string {
  let out = s
  if (out.includes("]") && out.includes(")")) {
    out = out.replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_m, alt: string, url: string) => {
        const src = safeImageSrc(url.replace(/&amp;/g, "&"))
        if (!src) return `![${alt}](${url})`
        return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" loading="lazy" class="kobe-md-img">`
      },
    )
  }
  if (out.includes("]") && out.includes(")")) {
    out = out.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_m, text: string, url: string) => {
        const href = safeHref(url.replace(/&amp;/g, "&"))
        if (!href) return `${text}(${url})`
        return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" class="kobe-md-link">${text}</a>`
      },
    )
  }
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
  out = out.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
  return out
}

function renderInline(escaped: string): string {
  return escaped
    .split(/(`[^`]+`)/g)
    .map((part, idx) => {
      if (idx % 2 === 1) {
        return `<code class="kobe-md-code">${part.slice(1, -1)}</code>`
      }
      return transformSpans(part)
    })
    .join("")
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

    if (/^```/.test(line)) {
      closeList()
      const body: string[] = []
      i++
      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(escapeHtml(lines[i]))
        i++
      }
      i++
      html.push(
        `<pre class="kobe-md-pre"><code>${body.join("\n")}</code></pre>`,
      )
      continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList()
      html.push('<hr class="kobe-md-hr" />')
      i++
      continue
    }

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

    if (/^>\s?/.test(line)) {
      closeList()
      html.push(
        `<blockquote class="kobe-md-quote">${renderInline(escapeHtml(line.replace(/^>\s?/, "")))}</blockquote>`,
      )
      i++
      continue
    }

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

    if (line.trim() === "") {
      closeList()
      i++
      continue
    }

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
