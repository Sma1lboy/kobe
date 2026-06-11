import { describe, expect, it } from "vitest"
import { renderMarkdown } from "../src/lib/markdown.ts"

/**
 * The notes preview renders via dangerouslySetInnerHTML, so the security
 * invariant — escape first, never emit user HTML, drop unsafe link schemes —
 * is the load-bearing thing to lock down. Plus the basic block/inline subset.
 */

describe("renderMarkdown — safety", () => {
  it("escapes raw HTML so it can't inject markup", () => {
    const out = renderMarkdown("<script>alert(1)</script>")
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
  })

  it("escapes HTML inside inline code", () => {
    const out = renderMarkdown("`<img src=x onerror=1>`")
    expect(out).toContain("<code")
    expect(out).not.toContain("<img")
    expect(out).toContain("&lt;img")
  })

  it("drops javascript: link hrefs (renders as inert text, no anchor)", () => {
    const out = renderMarkdown("[click](javascript:alert(1))")
    // The safety property: no href attribute and no <a> tag — the unsafe URL
    // survives only as inert paragraph text, never as a navigable link.
    expect(out).not.toContain("href")
    expect(out).not.toContain("<a ")
    expect(out).toContain("click")
  })

  it("keeps http/https links with rel=noopener and target=_blank", () => {
    const out = renderMarkdown("[kobe](https://example.com/x)")
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('target="_blank"')
  })

  it("allows relative/anchor links", () => {
    expect(renderMarkdown("[a](/path)")).toContain('href="/path"')
    expect(renderMarkdown("[b](#sec)")).toContain('href="#sec"')
  })
})

describe("renderMarkdown — blocks & inline", () => {
  it("renders headings at the right level", () => {
    expect(renderMarkdown("# Title")).toContain("<h1")
    expect(renderMarkdown("### Sub")).toContain("<h3")
  })

  it("renders unordered and ordered lists", () => {
    const ul = renderMarkdown("- a\n- b")
    expect(ul).toContain("<ul")
    expect((ul.match(/<li>/g) ?? []).length).toBe(2)
    const ol = renderMarkdown("1. one\n2. two")
    expect(ol).toContain("<ol")
  })

  it("renders fenced code blocks with escaped content", () => {
    const out = renderMarkdown("```\nconst x = a < b\n```")
    expect(out).toContain("<pre")
    expect(out).toContain("a &lt; b")
  })

  it("renders bold, italic, blockquote, hr", () => {
    expect(renderMarkdown("**b**")).toContain("<strong>b</strong>")
    expect(renderMarkdown("a *i* z")).toContain("<em>i</em>")
    expect(renderMarkdown("> quote")).toContain("<blockquote")
    expect(renderMarkdown("---")).toContain("<hr")
  })

  it("groups plain lines into a paragraph", () => {
    const out = renderMarkdown("hello\nworld")
    expect((out.match(/<p/g) ?? []).length).toBe(1)
    expect(out).toContain("hello world")
  })

  it("returns empty string for empty input", () => {
    expect(renderMarkdown("").trim()).toBe("")
  })
})
