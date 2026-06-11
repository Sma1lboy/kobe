import { describe, expect, it } from "vitest"
import { renderMarkdown } from "../src/lib/markdown.ts"

/**
 * Extra invariants on the notes markdown renderer — the highest-risk file in
 * kobe-web (it feeds dangerouslySetInnerHTML). These lock CURRENT behavior on
 * the injection-adjacent edges that markdown.test.ts doesn't already cover, so
 * a future tweak to the link/emphasis passes can't silently open a hole.
 * No production change — coverage only.
 */

describe("renderMarkdown — link scheme hardening", () => {
  it("drops data: URLs (a known XSS vector) to inert text", () => {
    const out = renderMarkdown("[x](data:text/html,boom)")
    expect(out).not.toContain("href")
    expect(out).not.toContain("<a ")
    expect(out).toContain("x(data:text/html,boom)")
  })

  it("drops vbscript: URLs to inert text", () => {
    const out = renderMarkdown("[x](vbscript:msgbox)")
    expect(out).not.toContain("href")
    expect(out).not.toContain("<a ")
  })

  it("round-trips an & in a safe URL without breaking the href or double-encoding", () => {
    const out = renderMarkdown("[a](https://x.com?a=1&b=2)")
    // The & is entity-encoded exactly once inside the attribute — not raw
    // (which could break out) and not double-encoded (&amp;amp;).
    expect(out).toContain('href="https://x.com?a=1&amp;b=2"')
    expect(out).not.toContain("&amp;amp;")
  })

  it("renders multiple links on one line independently", () => {
    const out = renderMarkdown(
      "see [one](https://a.com) and [two](https://b.com)",
    )
    expect((out.match(/<a /g) ?? []).length).toBe(2)
    expect(out).toContain('href="https://a.com"')
    expect(out).toContain('href="https://b.com"')
  })
})

describe("renderMarkdown — no image/raw-markup vectors", () => {
  it("does NOT emit an <img> for image syntax (the ! survives as text)", () => {
    const out = renderMarkdown("![alt](https://x.com/i.png)")
    expect(out).not.toContain("<img")
    // Current behavior: the link pass turns the [alt](url) into an anchor and
    // leaves the leading ! as literal text — never a raw image element.
    expect(out).toContain("!<a ")
  })

  it("escapes an onerror payload smuggled through image alt text", () => {
    const out = renderMarkdown('![<img src=x onerror=1>](https://x.com)')
    expect(out).not.toContain("<img")
    expect(out).toContain("&lt;img")
  })
})

describe("renderMarkdown — emphasis edges", () => {
  it("leaves an unclosed ** as literal text (no dangling <strong>)", () => {
    const out = renderMarkdown("**bold")
    expect(out).not.toContain("<strong>")
    expect(out).toContain("**bold")
  })

  it("renders inline code and bold together inside a heading", () => {
    const out = renderMarkdown("# Title with `code` and **bold**")
    expect(out).toContain("<h1")
    expect(out).toContain('<code class="kobe-md-code">code</code>')
    expect(out).toContain("<strong>bold</strong>")
  })

  it("does not pair a * inside inline code with a * outside it", () => {
    // The code-span split means the `*` in `a*b` can't open emphasis that
    // closes at the trailing `*c*` outside the span.
    const out = renderMarkdown("`a*b` *c*")
    expect(out).toContain("<code")
    expect(out).toContain("<em>c</em>")
    // the code span content is untouched
    expect(out).toContain("a*b")
  })
})
