import { describe, expect, it } from "vitest"
import { renderMarkdown } from "../src/lib/markdown.ts"

/**
 * Focused scheme-bypass + structural resistance for the notes renderer (the
 * app's one dangerouslySetInnerHTML sink). The classic XSS bypass is a
 * case-varied or whitespace-padded `javascript:` URL; the scheme allowlist
 * must reject all of them, and a few structural edges must stay inert too.
 */

describe("renderMarkdown — scheme bypass resistance", () => {
  const bypasses = [
    "[x](JavaScript:alert(1))",
    "[x](JAVASCRIPT:alert(1))",
    "[x](  javascript:alert(1))", // leading whitespace
    "[x](java\tscript:alert(1))", // embedded tab
    "[x](DATA:text/html,boom)", // uppercase data:
    "[x](vbscript:msgbox)",
  ]

  for (const md of bypasses) {
    it(`drops the unsafe URL in ${JSON.stringify(md)}`, () => {
      const out = renderMarkdown(md)
      expect(out).not.toContain("<a ")
      expect(out).not.toContain("href")
      // and never emits a raw <script>/on* — the whole thing stays escaped text
      expect(out).not.toContain("<script")
    })
  }

  it("still accepts an uppercase but safe HTTP scheme", () => {
    const out = renderMarkdown("[a](HTTP://Example.COM)")
    expect(out).toContain('href="HTTP://Example.COM"')
    expect(out).toContain('rel="noopener noreferrer"')
  })
})

describe("renderMarkdown — structural inertness", () => {
  it("does not make an empty-text link clickable", () => {
    const out = renderMarkdown("[](http://a.com)")
    expect(out).not.toContain("<a ")
    expect(out).toContain("[](http://a.com)")
  })

  it("truncates a URL at the first ) without breaking out of the href", () => {
    // The link regex stops the URL at the first ), so the tail becomes text —
    // the anchor that IS produced still carries a valid, escaped href.
    const out = renderMarkdown("[x](http://a.com/foo(bar))")
    expect(out).toContain('href="http://a.com/foo(bar"')
    expect(out).not.toContain("javascript")
    // no unescaped attribute break-out
    expect(out).not.toMatch(/href="[^"]*"[^>]*on\w+=/)
  })

  it("caps headings at h6 — 7 hashes is a paragraph, not <h7>", () => {
    expect(renderMarkdown("###### h6")).toContain("<h6")
    const seven = renderMarkdown("####### too many")
    expect(seven).not.toContain("<h7")
    expect(seven).toContain("<p")
  })

  it("escapes raw <, >, &, \" in plain prose", () => {
    const out = renderMarkdown('a & b < c > d " e')
    expect(out).toContain("a &amp; b &lt; c &gt; d &quot; e")
  })

  it("renders emphasis inside a blockquote and a link inside a list item", () => {
    expect(renderMarkdown("> **bold** in a quote")).toContain(
      "<strong>bold</strong>",
    )
    const list = renderMarkdown("- [link](https://x.com) in a list")
    expect(list).toContain("<li>")
    expect(list).toContain('href="https://x.com"')
  })
})
