/**
 * Unit tests for `image-paste.ts` — the `ImagePasteRegistry` (disk writes +
 * `[Image #N]` token bookkeeping) and the `prettifyPastedImageRefs` display
 * inverse. Real PNG bytes are written under a temp `KOBE_HOME_DIR`; the
 * clipboard seam (`./clipboard-image`) is mocked so `saveFromClipboard` never
 * touches the real OS clipboard.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

let clipboardSupported = true
let clipboardHit = true
vi.mock("../../src/tui/chat/composer/clipboard-image", () => ({
  clipboardImageSupported: () => clipboardSupported,
  readClipboardImageToFile: vi.fn(async () => (clipboardHit ? { mimeType: "image/png" } : null)),
}))

import { ImagePasteRegistry, pastedImagesDir, prettifyPastedImageRefs } from "../../src/tui/chat/composer/image-paste"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kobe-img-"))
  process.env.KOBE_HOME_DIR = dir
  clipboardSupported = true
  clipboardHit = true
})
afterEach(() => {
  Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
  rmSync(dir, { recursive: true, force: true })
})

describe("ImagePasteRegistry.saveBytes", () => {
  test("writes bytes to disk and returns a numbered token", () => {
    const reg = new ImagePasteRegistry()
    const { token, entry } = reg.saveBytes(new Uint8Array([1, 2, 3]), "image/png")
    expect(token).toBe("[Image #1]")
    expect(entry.absPath.startsWith(pastedImagesDir())).toBe(true)
    expect(existsSync(entry.absPath)).toBe(true)
    expect(readFileSync(entry.absPath)).toEqual(Buffer.from([1, 2, 3]))
  })

  test("maps mime type to file extension, defaulting to .png", () => {
    const reg = new ImagePasteRegistry()
    expect(reg.saveBytes(new Uint8Array([0]), "image/jpeg").entry.absPath.endsWith(".jpg")).toBe(true)
    expect(reg.saveBytes(new Uint8Array([0]), "image/webp").entry.absPath.endsWith(".webp")).toBe(true)
    expect(reg.saveBytes(new Uint8Array([0]), "application/octet-stream").entry.absPath.endsWith(".png")).toBe(true)
  })

  test("ids increment; clear resets to #1", () => {
    const reg = new ImagePasteRegistry()
    reg.saveBytes(new Uint8Array([0]), "image/png")
    expect(reg.saveBytes(new Uint8Array([0]), "image/png").token).toBe("[Image #2]")
    expect(reg.hasEntries()).toBe(true)
    reg.clear()
    expect(reg.hasEntries()).toBe(false)
    expect(reg.saveBytes(new Uint8Array([0]), "image/png").token).toBe("[Image #1]")
  })
})

describe("ImagePasteRegistry.expand", () => {
  test("rewrites known tokens to spaced @paths, leaves unknown tokens intact", () => {
    const reg = new ImagePasteRegistry()
    const { entry } = reg.saveBytes(new Uint8Array([0]), "image/png")
    expect(reg.expand("look [Image #1] here")).toBe(`look  @${entry.absPath}  here`)
    expect(reg.expand("stale [Image #9]")).toBe("stale [Image #9]")
  })
})

describe("ImagePasteRegistry.saveFromClipboard", () => {
  test("registers a token on a clipboard hit", async () => {
    const reg = new ImagePasteRegistry()
    const result = await reg.saveFromClipboard()
    expect(result?.token).toBe("[Image #1]")
  })

  test("returns null when unsupported or empty", async () => {
    clipboardSupported = false
    expect(await new ImagePasteRegistry().saveFromClipboard()).toBeNull()
    clipboardSupported = true
    clipboardHit = false
    expect(await new ImagePasteRegistry().saveFromClipboard()).toBeNull()
  })
})

describe("prettifyPastedImageRefs", () => {
  test("collapses paste-dir @refs back to numbered placeholders", () => {
    const p1 = join(pastedImagesDir(), "a.png")
    const p2 = join(pastedImagesDir(), "b.png")
    expect(prettifyPastedImageRefs(`hi @${p1} and @${p2} done`)).toBe("hi [Image #1] and [Image #2] done")
  })

  test("leaves hand-typed @paths outside the paste dir untouched", () => {
    expect(prettifyPastedImageRefs("see @/some/other/pic.png")).toBe("see @/some/other/pic.png")
  })

  test("no-op when there's no @ at all", () => {
    expect(prettifyPastedImageRefs("plain prompt")).toBe("plain prompt")
  })
})
