/**
 * Unit tests for the chat-pane markdown parser.
 *
 * The parsers are pure functions that drive what assistant messages
 * actually look like. The renderer (`Markdown.tsx`) is thin glue —
 * if these tests pin the token shape, the rendered output is
 * deterministic. Behavior smoke tests handle the JSX wiring.
 *
 * We import from `markdown-parser.ts` (the no-opentui sibling), not
 * `Markdown.tsx`, because `@opentui/core` pulls in tree-sitter native
 * code that vitest's worker pool can't load. Same dance the
 * `help-dialog-helpers` tests do.
 */
import { describe, expect, test } from "vitest"
import { parseBlocks, parseInline } from "../../src/tui/panes/chat/markdown-parser"

describe("parseBlocks", () => {
  test("plain paragraph", () => {
    expect(parseBlocks("hello world")).toEqual([{ kind: "paragraph", text: "hello world" }])
  })

  test("ATX heading levels 1-6", () => {
    const out = parseBlocks("# h1\n## h2\n### h3\n#### h4\n##### h5\n###### h6")
    expect(out).toEqual([
      { kind: "heading", level: 1, text: "h1" },
      { kind: "heading", level: 2, text: "h2" },
      { kind: "heading", level: 3, text: "h3" },
      { kind: "heading", level: 4, text: "h4" },
      { kind: "heading", level: 5, text: "h5" },
      { kind: "heading", level: 6, text: "h6" },
    ])
  })

  test("7+ # is not a heading (CommonMark)", () => {
    // Matches GFM/CommonMark: 7 hashes followed by space falls back to
    // paragraph because the rune class is bounded at 6.
    expect(parseBlocks("####### deep")).toEqual([{ kind: "paragraph", text: "####### deep" }])
  })

  test("# without trailing space stays paragraph", () => {
    expect(parseBlocks("#hashtag")).toEqual([{ kind: "paragraph", text: "#hashtag" }])
  })

  test("unordered list collapses contiguous - / *", () => {
    expect(parseBlocks("- one\n- two\n* three")).toEqual([
      { kind: "list", ordered: false, start: 1, items: [{ text: "one" }, { text: "two" }, { text: "three" }] },
    ])
  })

  test("ordered list captures start number", () => {
    expect(parseBlocks("5. five\n6. six\n7. seven")).toEqual([
      { kind: "list", ordered: true, start: 5, items: [{ text: "five" }, { text: "six" }, { text: "seven" }] },
    ])
  })

  test("ordered and unordered lists do not merge", () => {
    expect(parseBlocks("- bullet\n1. number")).toEqual([
      { kind: "list", ordered: false, start: 1, items: [{ text: "bullet" }] },
      { kind: "list", ordered: true, start: 1, items: [{ text: "number" }] },
    ])
  })

  test("GFM task list items pick up checked state", () => {
    expect(parseBlocks("- [ ] todo\n- [x] done\n- [X] also done\n- plain bullet")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          { text: "todo", checked: false },
          { text: "done", checked: true },
          { text: "also done", checked: true },
          { text: "plain bullet" },
        ],
      },
    ])
  })

  test("horizontal rule — three dashes / asterisks / underscores", () => {
    expect(parseBlocks("---")).toEqual([{ kind: "hr" }])
    expect(parseBlocks("***")).toEqual([{ kind: "hr" }])
    expect(parseBlocks("___")).toEqual([{ kind: "hr" }])
    expect(parseBlocks("- - -")).toEqual([{ kind: "hr" }])
  })

  test("HR breaks paragraph flow", () => {
    expect(parseBlocks("intro\n---\nafter")).toEqual([
      { kind: "paragraph", text: "intro" },
      { kind: "hr" },
      { kind: "paragraph", text: "after" },
    ])
  })

  test("simple GFM table — two cols, two rows", () => {
    const src = "| Name | Score |\n| --- | --- |\n| Alice | 1 |\n| Bob | 2 |"
    expect(parseBlocks(src)).toEqual([
      {
        kind: "table",
        align: ["left", "left"],
        header: ["Name", "Score"],
        rows: [
          ["Alice", "1"],
          ["Bob", "2"],
        ],
      },
    ])
  })

  test("table separator alignment markers", () => {
    const src = "| L | C | R |\n| :--- | :---: | ---: |\n| a | b | c |"
    expect(parseBlocks(src)).toEqual([
      {
        kind: "table",
        align: ["left", "center", "right"],
        header: ["L", "C", "R"],
        rows: [["a", "b", "c"]],
      },
    ])
  })

  test("table row gets padded / clipped to header column count", () => {
    const src = "| a | b |\n| --- | --- |\n| only-one |\n| one | two | three |"
    expect(parseBlocks(src)).toEqual([
      {
        kind: "table",
        align: ["left", "left"],
        header: ["a", "b"],
        rows: [
          ["only-one", ""],
          ["one", "two"],
        ],
      },
    ])
  })

  test("paragraph with `|` but no separator stays a paragraph", () => {
    expect(parseBlocks("a | b")).toEqual([{ kind: "paragraph", text: "a | b" }])
  })

  test("blockquote strips leading >", () => {
    expect(parseBlocks("> quoted\n> still quoted")).toEqual([{ kind: "blockquote", lines: ["quoted", "still quoted"] }])
  })

  test("blockquote without space after > still parses", () => {
    expect(parseBlocks(">tight")).toEqual([{ kind: "blockquote", lines: ["tight"] }])
  })

  test("fenced code block", () => {
    expect(parseBlocks("```ts\nconst x = 1\n```")).toEqual([{ kind: "code", lang: "ts", lines: ["const x = 1"] }])
  })

  test("unclosed fence keeps streaming content", () => {
    // Streaming case: closing ``` hasn't arrived yet.
    expect(parseBlocks("```\nhalf\nway")).toEqual([{ kind: "code", lang: "", lines: ["half", "way"] }])
  })

  test("paragraph break on heading boundary", () => {
    expect(parseBlocks("intro line\n# Title\nafter")).toEqual([
      { kind: "paragraph", text: "intro line" },
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "after" },
    ])
  })

  test("paragraph break on blockquote boundary", () => {
    expect(parseBlocks("paragraph\n> quote")).toEqual([
      { kind: "paragraph", text: "paragraph" },
      { kind: "blockquote", lines: ["quote"] },
    ])
  })
})

describe("parseInline", () => {
  test("plain text passes through", () => {
    expect(parseInline("hello world")).toEqual([{ kind: "text", text: "hello world" }])
  })

  test("link with display text", () => {
    expect(parseInline("see [the docs](https://example.com)")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "the docs", href: "https://example.com" },
    ])
  })

  test("bare-URL link", () => {
    expect(parseInline("[https://x.io](https://x.io)")).toEqual([
      { kind: "link", text: "https://x.io", href: "https://x.io" },
    ])
  })

  test("link with whitespace href falls back to literal", () => {
    // `[a](b c)` is not a link — render as text.
    const tokens = parseInline("[a](b c)")
    expect(tokens.every((t) => t.kind === "text")).toBe(true)
    expect(tokens.map((t) => t.text).join("")).toBe("[a](b c)")
  })

  test("link with empty href falls back to literal", () => {
    const tokens = parseInline("[a]()")
    expect(tokens.every((t) => t.kind === "text")).toBe(true)
    expect(tokens.map((t) => t.text).join("")).toBe("[a]()")
  })

  test("missing closing paren falls back to literal", () => {
    const tokens = parseInline("[a](unterminated")
    expect(tokens.every((t) => t.kind === "text")).toBe(true)
  })

  test("link sits next to bold without merging", () => {
    expect(parseInline("**bold** [link](u)")).toEqual([
      { kind: "bold", text: "bold" },
      { kind: "text", text: " " },
      { kind: "link", text: "link", href: "u" },
    ])
  })

  test("inline code still wins over link bracket", () => {
    expect(parseInline("`[not a link](x)`")).toEqual([{ kind: "code", text: "[not a link](x)" }])
  })

  test("bold and italic still parse alongside new link branch", () => {
    expect(parseInline("**b** _i_")).toEqual([
      { kind: "bold", text: "b" },
      { kind: "text", text: " " },
      { kind: "italic", text: "i" },
    ])
  })

  test("bare URL autolinks without [text](href) wrapper", () => {
    expect(parseInline("see https://example.com for more")).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "https://example.com", href: "https://example.com" },
      { kind: "text", text: " for more" },
    ])
  })

  test("bare URL trims trailing sentence punctuation", () => {
    expect(parseInline("visit https://example.com.")).toEqual([
      { kind: "text", text: "visit " },
      { kind: "link", text: "https://example.com", href: "https://example.com" },
      { kind: "text", text: "." },
    ])
  })

  test("bare URL inside [text](href) does not double-fire", () => {
    expect(parseInline("[docs](https://example.com)")).toEqual([
      { kind: "link", text: "docs", href: "https://example.com" },
    ])
  })

  test("bare URL only fires at word boundary", () => {
    // `xhttps://...` is not a real URL — the explicit-link branch is the
    // only way to get one in mid-token.
    const out = parseInline("xhttps://nope.com")
    expect(out.every((t) => t.kind === "text")).toBe(true)
  })
})
