/**
 * Data half of the ops preview window (`tui/ops/preview-core.ts`), shared
 * by the Solid and React previews (issue #15, G3). Why these tests matter:
 * `loadPreviewData` decides which renderable the preview mounts — a dirty
 * file MUST render as a `<diff>` vs HEAD and a clean/untracked one as its
 * `<code>` content — and `filetypeOf` picks the tree-sitter grammar; both
 * were previously locked inside the untestable host.tsx.
 */

import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  filetypeOf,
  formatBytes,
  isImagePath,
  loadPreviewData,
  looksBinaryText,
} from "../../src/tui/ops/preview-core.ts"

describe("filetypeOf", () => {
  test("maps known extensions to their tree-sitter grammar and unknown ones to undefined", () => {
    expect(filetypeOf("src/a.ts")).toBe("typescript")
    expect(filetypeOf("src/a.tsx")).toBe("typescript")
    expect(filetypeOf("a.mjs")).toBe("javascript")
    expect(filetypeOf("README.markdown")).toBe("markdown")
    expect(filetypeOf("Makefile")).toBeUndefined()
    expect(filetypeOf("img.png")).toBeUndefined()
  })
})

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "kobe-preview-core-"))
  execFileSync("git", ["init", "-q"], { cwd: dir })
  writeFileSync(join(dir, "a.ts"), "export const a = 1\n")
  execFileSync("git", ["add", "a.ts"], { cwd: dir })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"], { cwd: dir })
  return dir
}

describe("loadPreviewData", () => {
  test("a changed file previews as the unified diff vs HEAD", async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, "a.ts"), "export const a = 2\n")
    const data = await loadPreviewData(repo, "a.ts")
    if (data.kind !== "diff") throw new Error(`expected diff, got ${data.kind}`)
    expect(data.text).toContain("-export const a = 1")
    expect(data.text).toContain("+export const a = 2")
  })

  test("a clean file previews as its content", async () => {
    const repo = makeRepo()
    const data = await loadPreviewData(repo, "a.ts")
    expect(data).toEqual({ kind: "code", text: "export const a = 1\n" })
  })

  test("a missing file degrades to empty content, not a throw", async () => {
    const repo = makeRepo()
    const data = await loadPreviewData(repo, "nope.ts")
    expect(data).toEqual({ kind: "code", text: "" })
  })

  // Why: a PNG decoded as utf8 renders as mojibake — image extensions and
  // null-byte content must route to the binary card, never <code>/<diff>.
  test("an image file previews as a binary card with its byte size", async () => {
    const repo = makeRepo()
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])
    writeFileSync(join(repo, "shot.png"), bytes)
    const data = await loadPreviewData(repo, "shot.png")
    expect(data).toEqual({ kind: "binary", image: true, sizeBytes: bytes.length })
  })

  test("a non-image file with null bytes previews as a non-image binary card", async () => {
    const repo = makeRepo()
    writeFileSync(join(repo, "blob.dat"), Buffer.from("abc\u0000def"))
    const data = await loadPreviewData(repo, "blob.dat")
    expect(data).toMatchObject({ kind: "binary", image: false })
  })
})

describe("binary detection helpers", () => {
  test("isImagePath keys off the extension, case-insensitively", () => {
    expect(isImagePath("a/b/shot.PNG")).toBe(true)
    expect(isImagePath("photo.jpeg")).toBe(true)
    expect(isImagePath("doc.pdf")).toBe(false)
    expect(isImagePath("src/a.ts")).toBe(false)
  })

  test("looksBinaryText flags null bytes and passes plain text", () => {
    expect(looksBinaryText("hello\u0000world")).toBe(true)
    expect(looksBinaryText("plain text\n")).toBe(false)
  })

  test("formatBytes picks a sane unit", () => {
    expect(formatBytes(340)).toBe("340 B")
    expect(formatBytes(1536)).toBe("1.5 KB")
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB")
  })
})
