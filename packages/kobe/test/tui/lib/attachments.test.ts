/**
 * Prompt-attachment parsing + rendering (quick-task multimodal paste).
 *
 * Why these matter: the paste interceptor decides whether pasted TEXT is
 * "attachment path(s)" (consume, attach) or ordinary prompt text (fall
 * through to the input). A false positive silently eats the user's text;
 * a false negative leaves a raw path in the prompt. The tests pin the
 * boundary: absolute + existing + known extension, all-lines-or-nothing
 * for multi-path pastes, and the exact `images[n]` / `pdf[n]` reference
 * format the engine receives.
 */

import { describe, expect, test } from "vitest"
import {
  appendAttachmentRefs,
  asAttachmentPath,
  asAttachmentPaths,
  attachmentLabel,
} from "../../../src/tui/lib/attachments"

const exists = (known: string[]) => (p: string) => known.includes(p)

describe("asAttachmentPath", () => {
  test("accepts an absolute existing image path", () => {
    expect(asAttachmentPath("/tmp/shot.png", exists(["/tmp/shot.png"]))).toBe("/tmp/shot.png")
  })

  test("strips outer quotes and shell escapes (terminal drag-drop)", () => {
    const real = "/tmp/name (15).png"
    expect(asAttachmentPath('"/tmp/name (15).png"', exists([real]))).toBe(real)
    expect(asAttachmentPath("/tmp/name\\ \\(15\\).png", exists([real]))).toBe(real)
  })

  test("rejects relative paths, unknown extensions, and missing files", () => {
    expect(asAttachmentPath("shot.png", exists(["shot.png"]))).toBeNull()
    expect(asAttachmentPath("/tmp/notes.txt", exists(["/tmp/notes.txt"]))).toBeNull()
    expect(asAttachmentPath("/tmp/gone.png", exists([]))).toBeNull()
  })

  test("accepts pdf", () => {
    expect(asAttachmentPath("/tmp/spec.pdf", exists(["/tmp/spec.pdf"]))).toBe("/tmp/spec.pdf")
  })
})

describe("asAttachmentPaths (whole-paste gate)", () => {
  test("multi-line Finder copy: all lines must resolve", () => {
    const known = ["/a/x.png", "/a/y.pdf"]
    expect(asAttachmentPaths("/a/x.png\n/a/y.pdf\n", exists(known))).toEqual(known)
    // One ordinary-text line → the WHOLE paste is prompt text, not attachments.
    expect(asAttachmentPaths("/a/x.png\nfix this bug", exists(known))).toBeNull()
  })

  test("plain prose and empty pastes fall through", () => {
    expect(asAttachmentPaths("refactor the parser", exists([]))).toBeNull()
    expect(asAttachmentPaths("  \n ", exists([]))).toBeNull()
  })
})

describe("rendering", () => {
  test("labels: images[n] for images, pdf[n] for pdfs", () => {
    expect(attachmentLabel("/a/x.png", 0)).toBe("images[0]")
    expect(attachmentLabel("/a/y.PDF", 1)).toBe("pdf[1]")
  })

  test("appendAttachmentRefs formats the delivered prompt", () => {
    expect(appendAttachmentRefs("fix the layout", ["/a/x.png", "/a/y.pdf"])).toBe(
      "fix the layout\n\nimages[0]: /a/x.png\npdf[1]: /a/y.pdf",
    )
    expect(appendAttachmentRefs("no attachments", [])).toBe("no attachments")
  })
})
