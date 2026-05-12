/**
 * Unit tests for the chat composer's image-paste core
 * (`src/tui/panes/chat/composer/image-paste.ts`).
 *
 * What these tests prove:
 *
 *   1. {@link ImagePasteRegistry.saveBytes} writes the bytes to disk
 *      under `~/.kobe/pasted-images/` and returns a `[Image #N]`
 *      placeholder. We assert the file exists with the right length
 *      so a later regression that "forgets" to write or mishandles
 *      Uint8Array slicing fails loudly.
 *
 *   2. {@link ImagePasteRegistry.expand} is the load-bearing piece
 *      between the placeholder UX and the `claude -p "..."` engine
 *      call. The engine only resolves images via in-prompt `@/abs/path`
 *      references, so the round-trip from `[Image #1]` → ` @/abs/...`
 *      MUST work; if expansion is broken, image attachments silently
 *      reach Claude as literal `[Image #1]` text and the model has no
 *      way to see the user's screenshot. Tests cover: single token,
 *      multiple tokens at distinct positions, tokens with unknown
 *      ids passing through unchanged, and idempotency after `clear()`.
 *
 *   3. ID numbering resets after `clear()` so the next composer turn
 *      starts at `#1` (matches claude-code's `pastedContents` UX).
 *
 * Test isolation:
 *
 *   Each test gets a fresh tmpdir and points `KOBE_HOME_DIR` at it
 *   so `pastedImagesDir()` writes there instead of the user's real
 *   `~/.kobe/`. We restore the env in afterEach.
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { ImagePasteRegistry, pastedImagesDir, prettifyPastedImageRefs } from "@/tui/panes/chat/composer/image-paste"
import { afterEach, beforeEach, describe, expect, test } from "vitest"

let tmpRoot: string
let savedKobeHome: string | undefined

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kobe-imgpaste-"))
  savedKobeHome = process.env.KOBE_HOME_DIR
  process.env.KOBE_HOME_DIR = tmpRoot
})

afterEach(() => {
  // biome-ignore lint/performance/noDelete: test cleanup needs the env key fully removed (assigning undefined leaves it as the string "undefined").
  if (savedKobeHome === undefined) delete process.env.KOBE_HOME_DIR
  else process.env.KOBE_HOME_DIR = savedKobeHome
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

// 8-byte PNG signature is enough to prove "we wrote *these* bytes" —
// we never decode the image, just round-trip it through the registry.
const FAKE_PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe("ImagePasteRegistry.saveBytes", () => {
  test("writes bytes to ~/.kobe/pasted-images/ and returns [Image #1]", () => {
    const reg = new ImagePasteRegistry()
    const result = reg.saveBytes(FAKE_PNG, "image/png")

    expect(result.token).toBe("[Image #1]")
    expect(result.entry.id).toBe(1)
    expect(result.entry.absPath.startsWith(pastedImagesDir())).toBe(true)
    expect(result.entry.absPath.endsWith(".png")).toBe(true)

    const onDisk = fs.readFileSync(result.entry.absPath)
    expect(onDisk.length).toBe(FAKE_PNG.length)
    expect(Array.from(onDisk)).toEqual(Array.from(FAKE_PNG))
  })

  test("subsequent saves increment the id", () => {
    const reg = new ImagePasteRegistry()
    const first = reg.saveBytes(FAKE_PNG, "image/png")
    const second = reg.saveBytes(FAKE_PNG, "image/png")
    const third = reg.saveBytes(FAKE_PNG, "image/png")
    expect(first.token).toBe("[Image #1]")
    expect(second.token).toBe("[Image #2]")
    expect(third.token).toBe("[Image #3]")
    // Each save mints a unique path so a slow clipboard read can't
    // overwrite an earlier image mid-compose.
    expect(new Set([first.entry.absPath, second.entry.absPath, third.entry.absPath]).size).toBe(3)
  })

  test("non-png mime types pick a sensible extension", () => {
    const reg = new ImagePasteRegistry()
    const jpg = reg.saveBytes(FAKE_PNG, "image/jpeg")
    const webp = reg.saveBytes(FAKE_PNG, "image/webp")
    const unknown = reg.saveBytes(FAKE_PNG, "image/x-weird")
    expect(jpg.entry.absPath.endsWith(".jpg")).toBe(true)
    expect(webp.entry.absPath.endsWith(".webp")).toBe(true)
    // Unknown image/* mime types fall back to .png — the engine reads
    // images by content sniffing anyway, the extension is cosmetic.
    expect(unknown.entry.absPath.endsWith(".png")).toBe(true)
  })
})

describe("ImagePasteRegistry.expand", () => {
  test("expands a single token to ` @<absPath> `", () => {
    const reg = new ImagePasteRegistry()
    const { entry } = reg.saveBytes(FAKE_PNG, "image/png")
    const expanded = reg.expand("look at [Image #1] please")
    expect(expanded).toBe(`look at  @${entry.absPath}  please`)
  })

  test("expands multiple tokens at distinct positions", () => {
    const reg = new ImagePasteRegistry()
    const a = reg.saveBytes(FAKE_PNG, "image/png")
    const b = reg.saveBytes(FAKE_PNG, "image/png")
    const expanded = reg.expand("compare [Image #1] vs [Image #2]")
    expect(expanded).toBe(`compare  @${a.entry.absPath}  vs  @${b.entry.absPath} `)
  })

  test("unknown ids pass through unchanged", () => {
    const reg = new ImagePasteRegistry()
    reg.saveBytes(FAKE_PNG, "image/png") // id 1
    // `[Image #99]` doesn't exist — should stay literal so a recalled
    // history entry doesn't get silently mangled when its registry is
    // gone.
    const expanded = reg.expand("see [Image #1] and [Image #99]")
    expect(expanded).toContain("[Image #99]")
    expect(expanded).not.toContain("[Image #1]")
  })

  test("expand on an empty registry is a no-op", () => {
    const reg = new ImagePasteRegistry()
    expect(reg.hasEntries()).toBe(false)
    expect(reg.expand("plain text [Image #1] still here")).toBe("plain text [Image #1] still here")
  })
})

describe("prettifyPastedImageRefs", () => {
  test("collapses a single ref to `[Image #1]` with single spaces", () => {
    const reg = new ImagePasteRegistry()
    const { entry } = reg.saveBytes(FAKE_PNG, "image/png")
    const expanded = reg.expand("look at [Image #1] please")
    // Sanity: `expand` produces double-spaced ` @path ` around the path.
    expect(expanded).toBe(`look at  @${entry.absPath}  please`)
    expect(prettifyPastedImageRefs(expanded)).toBe("look at [Image #1] please")
  })

  test("numbers multiple refs in order", () => {
    const reg = new ImagePasteRegistry()
    reg.saveBytes(FAKE_PNG, "image/png")
    reg.saveBytes(FAKE_PNG, "image/png")
    const expanded = reg.expand("compare [Image #1] vs [Image #2]")
    expect(prettifyPastedImageRefs(expanded)).toBe("compare [Image #1] vs [Image #2]")
  })

  test("leaves non-paste-dir `@/path` refs alone", () => {
    // A user-typed `@/etc/hosts` should NOT be folded into `[Image]` —
    // the prettifier only matches paths under the kobe paste dir.
    const text = "see @/etc/hosts for routing"
    expect(prettifyPastedImageRefs(text)).toBe(text)
  })

  test("is a no-op when no `@` is present", () => {
    expect(prettifyPastedImageRefs("plain message")).toBe("plain message")
  })
})

describe("ImagePasteRegistry.clear", () => {
  test("drops entries and resets the id counter", () => {
    const reg = new ImagePasteRegistry()
    reg.saveBytes(FAKE_PNG, "image/png")
    reg.saveBytes(FAKE_PNG, "image/png")
    expect(reg.hasEntries()).toBe(true)

    reg.clear()
    expect(reg.hasEntries()).toBe(false)
    // Subsequent expansion no longer rewrites old tokens — they
    // become literal text (which would land in chat verbatim, but
    // the composer expands BEFORE clear, so this only matters for
    // history-recall paths that re-enter via setBuffer).
    expect(reg.expand("[Image #1]")).toBe("[Image #1]")

    // Next save starts fresh at #1, matching the user-facing "this
    // is a new turn" expectation.
    const fresh = reg.saveBytes(FAKE_PNG, "image/png")
    expect(fresh.token).toBe("[Image #1]")
  })
})
