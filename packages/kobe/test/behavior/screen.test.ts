/**
 * Unit tests for the ANSI screen parser.
 *
 * Why these tests exist: the screen parser is the foundation that
 * every behavior assertion rests on. If it eats real text or leaves
 * escape codes in the output, every downstream test gets harder to
 * write and harder to debug. So we verify the basics here, in
 * isolation, so behavior tests can trust `capture()`.
 */

import { describe, expect, test } from "vitest"
import { normalizeScreen, stripAnsi } from "./screen"

describe("stripAnsi", () => {
  test("removes CSI color codes", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red")
  })

  test("removes 24-bit truecolor codes (the format opentui emits)", () => {
    expect(stripAnsi("\x1b[38;2;255;255;255mhi\x1b[0m there")).toBe("hi there")
  })

  test("removes cursor positioning sequences", () => {
    expect(stripAnsi("\x1b[1;1Hkobe\x1b[2;1H— booting")).toBe("kobe— booting")
  })

  test("removes OSC sequences (window titles, hyperlinks)", () => {
    expect(stripAnsi("\x1b]0;some title\x07after")).toBe("after")
    expect(stripAnsi("\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\")).toBe("link")
  })

  test("removes alt-screen and mouse-mode toggles", () => {
    const noisy = "\x1b[?1049h\x1b[?1000h\x1b[?2004hclean\x1b[?2004l\x1b[?1000l\x1b[?1049l"
    expect(stripAnsi(noisy)).toBe("clean")
  })

  test("preserves newlines, carriage returns, and tabs", () => {
    expect(stripAnsi("a\nb\rc\td")).toBe("a\nb\rc\td")
  })

  test("drops bell, backspace, and other C0 controls", () => {
    expect(stripAnsi("ok\x07now\x08\x7f")).toBe("oknow")
  })
})

describe("normalizeScreen", () => {
  test("collapses CRLF to LF and trims trailing blank lines", () => {
    const raw = "\x1b[1;1Hkobe\r\nphase 0.1\r\n\r\n"
    expect(normalizeScreen(raw)).toBe("kobe\nphase 0.1")
  })

  test("preserves intra-content newlines", () => {
    expect(normalizeScreen("line one\nline two")).toBe("line one\nline two")
  })
})
