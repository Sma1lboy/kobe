/**
 * Unit tests for preview/xml-highlight.ts (KOB-14 stretch — SVG path).
 *
 * Validates the tokenizer's contract:
 *   - Every byte of input is preserved (lossless reconstruction).
 *   - Token kinds match what the renderer will color.
 *   - Multi-line tokens survive `splitTokensByLine` intact, with the
 *     newlines themselves used purely as row breaks.
 */
import { type XmlToken, splitTokensByLine, tokenizeXml } from "@/tui/panes/preview/xml-highlight"
import { describe, expect, it } from "vitest"

function reconstruct(tokens: readonly XmlToken[]): string {
  return tokens.map((t) => t.text).join("")
}

describe("tokenizeXml", () => {
  it("preserves every byte of input (lossless)", () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg"><rect x="1" y="2"/></svg>'
    expect(reconstruct(tokenizeXml(src))).toBe(src)
  })

  it("classifies a self-closing tag with one attribute", () => {
    const toks = tokenizeXml('<rect x="1"/>')
    expect(toks.map((t) => t.kind)).toEqual([
      "tag-delim", // <
      "tag-name", // rect
      "whitespace",
      "attr-name", // x
      "attr-eq",
      "attr-value", // "1"
      "tag-delim", // />
    ])
  })

  it("classifies a closing tag", () => {
    const toks = tokenizeXml("</g>")
    expect(toks.map((t) => t.kind)).toEqual(["tag-delim", "tag-name", "tag-delim"])
    expect(toks[0].text).toBe("</")
    expect(toks[1].text).toBe("g")
    expect(toks[2].text).toBe(">")
  })

  it("treats `<!-- … -->` as a single comment token", () => {
    const toks = tokenizeXml("<!-- hello world -->")
    expect(toks).toHaveLength(1)
    expect(toks[0]).toEqual({ kind: "comment", text: "<!-- hello world -->" })
  })

  it("treats `<![CDATA[…]]>` as a single cdata token", () => {
    const toks = tokenizeXml("<![CDATA[1 < 2]]>")
    expect(toks).toHaveLength(1)
    expect(toks[0]).toEqual({ kind: "cdata", text: "<![CDATA[1 < 2]]>" })
  })

  it("recognises XML processing instructions", () => {
    const toks = tokenizeXml('<?xml version="1.0"?>')
    expect(toks).toHaveLength(1)
    expect(toks[0].kind).toBe("doctype")
  })

  it("recognises DOCTYPE declarations", () => {
    const toks = tokenizeXml('<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">')
    expect(toks).toHaveLength(1)
    expect(toks[0].kind).toBe("doctype")
  })

  it("captures text content between tags as `text` tokens", () => {
    const toks = tokenizeXml("<title>Hello</title>")
    const text = toks.find((t) => t.kind === "text")
    expect(text?.text).toBe("Hello")
  })

  it("handles single-quoted attribute values", () => {
    const toks = tokenizeXml("<a href='/x'>")
    const v = toks.find((t) => t.kind === "attr-value")
    expect(v?.text).toBe("'/x'")
  })

  it("survives unterminated tags without infinite-looping", () => {
    expect(() => tokenizeXml("<rect x=")).not.toThrow()
    expect(reconstruct(tokenizeXml("<rect x="))).toBe("<rect x=")
  })

  it("does not collapse adjacent whitespace inside a tag", () => {
    const src = "<rect  x='1'>"
    expect(reconstruct(tokenizeXml(src))).toBe(src)
  })
})

describe("splitTokensByLine", () => {
  it("returns one row per source line, preserving non-newline tokens verbatim", () => {
    const src = "<a>\n  <b/>\n</a>"
    const rows = splitTokensByLine(tokenizeXml(src))
    expect(rows).toHaveLength(3)
    // Reconstructing each row and rejoining with newlines must equal source.
    const joined = rows.map((r) => r.map((t) => t.text).join("")).join("\n")
    expect(joined).toBe(src)
  })

  it("returns one row for input without any newlines", () => {
    const rows = splitTokensByLine(tokenizeXml("<svg/>"))
    expect(rows).toHaveLength(1)
  })

  it("handles trailing newline (yields an extra empty row)", () => {
    const rows = splitTokensByLine(tokenizeXml("<a/>\n"))
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual([])
  })

  it("splits a multi-line comment across rows", () => {
    const src = "<!--\n  line 2\n  line 3\n-->"
    const rows = splitTokensByLine(tokenizeXml(src))
    // 4 rows: "<!--", "  line 2", "  line 3", "-->"
    expect(rows).toHaveLength(4)
    expect(rows.flat().every((t) => t.kind === "comment")).toBe(true)
  })

  it("returns at least one row for empty input", () => {
    const rows = splitTokensByLine([])
    expect(rows).toEqual([[]])
  })
})
