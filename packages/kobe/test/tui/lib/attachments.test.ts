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

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
  appendAttachmentRefs,
  asAttachmentPath,
  asAttachmentPaths,
  attachmentLabel,
  captureClipboardAttachment,
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

/**
 * captureClipboardAttachment drives the OS clipboard through `Bun.spawn`
 * (osascript / wl-paste / xclip). In vitest's node env `Bun` is undefined, so
 * a fake `globalThis.Bun.spawn` is injected per test — `capture()` reads only
 * `{ stdout, exited }`, so a plain object stands in for a subprocess. Platform
 * is forced via defineProperty and restored after each test.
 */
describe("captureClipboardAttachment", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!
  let home: string
  let prevHome: string | undefined

  type FakeProc = { stdout: string | Uint8Array; exited: Promise<number> }
  const setSpawn = (impl: (cmd: string[]) => FakeProc) => {
    ;(globalThis as { Bun?: unknown }).Bun = { spawn: vi.fn((cmd: string[]) => impl(cmd)) }
  }
  const setPlatform = (platform: string) => {
    Object.defineProperty(process, "platform", { value: platform })
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "kobe-attach-"))
    prevHome = process.env.KOBE_HOME_DIR
    process.env.KOBE_HOME_DIR = home
  })

  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform)
    ;(globalThis as { Bun?: unknown }).Bun = undefined
    if (prevHome === undefined) Reflect.deleteProperty(process.env, "KOBE_HOME_DIR")
    else process.env.KOBE_HOME_DIR = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  test("darwin: a copied FILE resolves to its own path (no copy made)", async () => {
    setPlatform("darwin")
    const file = join(home, "shot.png")
    writeFileSync(file, "png-bytes")
    setSpawn((cmd) => {
      if (cmd.join(" ").includes("class furl")) return { stdout: `${file}\n`, exited: Promise.resolve(0) }
      throw new Error("unexpected spawn")
    })

    expect(await captureClipboardAttachment()).toBe(file)
  })

  test("darwin: raw PNG bytes are saved under ~/.kobe/attachments and that path returned", async () => {
    setPlatform("darwin")
    setSpawn((cmd) => {
      const joined = cmd.join(" ")
      if (joined.includes("class furl")) return { stdout: "", exited: Promise.resolve(1) } // no file on clipboard
      // The PNGf script embeds the destination path; write it like osascript would.
      const dest = joined.match(/POSIX file "([^"]+)"/)?.[1]
      if (dest) {
        writeFileSync(dest, "saved-png")
        return { stdout: "", exited: Promise.resolve(0) }
      }
      throw new Error("unexpected spawn")
    })

    const saved = await captureClipboardAttachment()
    expect(saved).toMatch(/\.kobe\/attachments\/paste-\d{8}-[0-9a-f]{8}\.png$/)
    expect(readFileSync(saved!, "utf8")).toBe("saved-png")
  })

  test("darwin: nothing attachable on the clipboard yields null", async () => {
    setPlatform("darwin")
    // Both osascript calls fail; the PNGf one also writes no file.
    setSpawn(() => ({ stdout: "", exited: Promise.resolve(1) }))
    expect(await captureClipboardAttachment()).toBeNull()
  })

  test("darwin: a PNGf 'success' without a file on disk still yields null (exists guard)", async () => {
    setPlatform("darwin")
    setSpawn(
      (cmd) =>
        cmd.join(" ").includes("class furl")
          ? { stdout: "", exited: Promise.resolve(1) }
          : { stdout: "", exited: Promise.resolve(0) }, // claims success, writes nothing
    )
    expect(await captureClipboardAttachment()).toBeNull()
  })

  test("linux: wl-paste bytes are written to a fresh attachment file", async () => {
    setPlatform("linux")
    const bytes = new Uint8Array([137, 80, 78, 71])
    setSpawn((cmd) => {
      if (cmd[0] === "wl-paste") return { stdout: bytes, exited: Promise.resolve(0) }
      throw new Error("should not fall through to xclip")
    })

    const saved = await captureClipboardAttachment()
    expect(saved).toMatch(/attachments\/paste-.*\.png$/)
    expect(existsSync(saved!)).toBe(true)
    expect(new Uint8Array(readFileSync(saved!))).toEqual(bytes)
  })

  test("linux: falls back to xclip when wl-paste is not installed", async () => {
    setPlatform("linux")
    const bytes = new Uint8Array([1, 2, 3])
    setSpawn((cmd) => {
      if (cmd[0] === "wl-paste") throw new Error("ENOENT") // binary missing
      if (cmd[0] === "xclip") return { stdout: bytes, exited: Promise.resolve(0) }
      throw new Error("unexpected spawn")
    })

    const saved = await captureClipboardAttachment()
    expect(saved).not.toBeNull()
    expect(new Uint8Array(readFileSync(saved!))).toEqual(bytes)
  })

  test("linux: no image target in either tool yields null", async () => {
    setPlatform("linux")
    setSpawn(() => ({ stdout: new Uint8Array(), exited: Promise.resolve(1) }))
    expect(await captureClipboardAttachment()).toBeNull()
  })

  test("unsupported platform yields null without spawning anything", async () => {
    setPlatform("win32")
    const spawn = vi.fn()
    ;(globalThis as { Bun?: unknown }).Bun = { spawn }
    expect(await captureClipboardAttachment()).toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })
})
