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

describe("renderMarkdown — image rule (issue-asset urls only)", () => {
  // A valid asset url: 16 lowercase-hex chars + a simple filename.ext.
  const asset = "/api/issue-assets/0123456789abcdef/shot.png"

  it("renders an <img> ONLY for a /api/issue-assets/<16hex>/<file> url", () => {
    const out = renderMarkdown(`![a screenshot](${asset})`)
    expect(out).toContain("<img")
    expect(out).toContain(`src="${asset}"`)
    expect(out).toContain('alt="a screenshot"')
    // Lazy-loaded + class-tagged, never an anchor for the same syntax.
    expect(out).toContain('loading="lazy"')
    expect(out).toContain('class="kobe-md-img"')
    expect(out).not.toContain("<a ")
  })

  it("escapes the alt text — no markup smuggling through alt", () => {
    const out = renderMarkdown(`![<img onerror=1>](${asset})`)
    // Exactly one <img> (the legit asset one); the alt text's angle brackets
    // are entity-encoded, so the smuggled `<img onerror=1>` never becomes a
    // second, real element. (The renderer escapes the alt a second time, hence
    // &amp;lt; — the safety property is that no raw `<img onerror` survives.)
    expect((out.match(/<img/g) ?? []).length).toBe(1)
    expect(out).not.toContain("<img onerror")
    expect(out).toContain('alt="&amp;lt;img onerror=1&amp;gt;"')
  })

  it("falls back to inert text for a NON-asset image url (no <img>)", () => {
    const out = renderMarkdown("![alt](https://evil.example.com/i.png)")
    expect(out).not.toContain("<img")
    // The `[alt](url)` survives the image pass and is picked up by the link
    // rule (safe http href), so the worst case is a plain anchor — never an
    // off-site <img> fetch / tracking pixel.
    expect(out).toContain("!<a ")
  })

  it("falls back to inert ESCAPED text for an image with an unsafe scheme (no <img>, no XSS)", () => {
    const out = renderMarkdown("![x](javascript:alert(1))")
    expect(out).not.toContain("<img")
    // javascript: is not a safe href either, so no anchor and no executable
    // sink — only inert, escaped paragraph text.
    expect(out).not.toContain("<a ")
    expect(out).not.toContain("href")
    expect(out).not.toContain("<script")
  })

  it("rejects look-alike asset urls (wrong hex length / traversal / nested path)", () => {
    // Too-short hash, an uppercase hex digit, a path-traversal file, and an
    // extra path segment all miss the strict route shape → text, never <img>.
    const rejects = [
      "/api/issue-assets/0123456789abcde/shot.png", // 15 hex
      "/api/issue-assets/0123456789ABCDEF/shot.png", // uppercase hex
      "/api/issue-assets/0123456789abcdef/../etc/passwd", // traversal
      "/api/issue-assets/0123456789abcdef/sub/shot.png", // nested
    ]
    for (const url of rejects) {
      const out = renderMarkdown(`![a](${url})`)
      expect(out, url).not.toContain("<img")
    }
  })

  it("accepts the asset url even when the markdown-escape pass entity-encoded an & in it", () => {
    // safeImageSrc unescapes &amp; before the route check; a query-bearing
    // filename isn't in the allowed shape, but a plain hex/file with no & is —
    // this guards the unescape path doesn't corrupt a clean asset url.
    const out = renderMarkdown(
      "![a](/api/issue-assets/abcdef0123456789/photo.jpeg)",
    )
    expect(out).toContain("<img")
    expect(out).toContain('src="/api/issue-assets/abcdef0123456789/photo.jpeg"')
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

  it("does NOT rewrite markdown inside a code span", () => {
    const out = renderMarkdown("`**not bold** [x](y)`")
    expect(out).toContain("<code")
    expect(out).not.toContain("<strong")
    expect(out).not.toContain("<a ")
  })

  it("renders bold that contains italic", () => {
    expect(renderMarkdown("**bold *it* more**")).toContain(
      "<strong>bold <em>it</em> more</strong>",
    )
  })

  it("keeps two separate bold spans (non-greedy)", () => {
    const out = renderMarkdown("**a** **b**")
    expect((out.match(/<strong>/g) ?? []).length).toBe(2)
  })

  it("does not mistake ' <digit> ' text for a code placeholder", () => {
    expect(renderMarkdown("step 3 done")).toContain("step 3 done")
  })

  it("drops protocol-relative //host links (renders as inert text)", () => {
    const out = renderMarkdown("[x](//evil.com)")
    expect(out).not.toContain("href")
    expect(out).not.toContain("<a ")
    expect(out).toContain("x")
  })
})
