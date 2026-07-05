import type { PasteEvent, TextareaRenderable } from "@opentui/core"
import { clipboardImageSupported } from "./clipboard-image"
import type { ImagePasteRegistry } from "./image-paste"

/**
 * Image-attach glue extracted from Composer. Owns the two entry points
 * that turn pasted / clipboard image bytes into a `[Image #N]`
 * placeholder token at the textarea cursor, plus the shared
 * `insertAtCursor` primitive they route through.
 */
export function createImageAttach(deps: {
  readonly getTextarea: () => TextareaRenderable | undefined
  readonly imageRegistry: ImagePasteRegistry
  readonly setPasteHint: (value: string | null) => void
}): {
  readonly insertAtCursor: (text: string) => void
  readonly handlePaste: (event: PasteEvent) => void
  readonly tryAttachClipboardImage: () => Promise<void>
} {
  const { getTextarea, imageRegistry, setPasteHint } = deps

  /**
   * Insert text at the textarea's current cursor position via the
   * EditBuffer's `insertText` (so it participates in undo and the
   * cursor walks forward as expected). Falls back silently when the
   * ref isn't mounted yet.
   */
  function insertAtCursor(text: string): void {
    const ref = getTextarea()
    if (!ref) return
    ref.insertText(text)
  }

  /**
   * Bracketed-paste handler. Most pastes are text — those fall through
   * to opentui's default `handlePaste` (we just don't preventDefault).
   * The image branch fires for pastes with `metadata.mimeType` starting
   * with `image/`; today no terminal we know of forwards image bytes
   * this way (macOS Cmd+V on a screenshot drops the bytes), but the
   * code path is wired in case a future terminal does, and so the
   * Ctrl+V path can share the same insertion logic.
   */
  function handlePaste(event: PasteEvent): void {
    const mime = event.metadata?.mimeType
    if (!mime || !mime.startsWith("image/")) return
    try {
      const result = imageRegistry.saveBytes(event.bytes, mime)
      // Surround with spaces so the token doesn't fuse with adjacent
      // typed text and stays cleanly tokenizable for the on-submit
      // expansion regex.
      insertAtCursor(` ${result.token} `)
      setPasteHint(null)
      event.preventDefault()
    } catch (err) {
      // Disk write failed (permissions, no space, etc.). Surface a
      // hint and let the default paste try its luck — at worst the
      // user sees garbled bytes inserted, which is a clear signal that
      // something went wrong on our side rather than a silent drop.
      setPasteHint(`paste failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * Try to read an image off the OS clipboard and insert a placeholder
   * token at the cursor. Async: the osascript read runs as an async
   * spawn (sync subprocesses are banned in render processes), so the
   * token appears ~100ms after the gesture. Surfaces a one-line hint
   * when there's nothing to paste, the platform isn't supported, or
   * the read failed.
   */
  async function tryAttachClipboardImage(): Promise<void> {
    if (!clipboardImageSupported()) {
      setPasteHint(`image paste not yet supported on ${process.platform}`)
      return
    }
    try {
      const result = await imageRegistry.saveFromClipboard()
      if (!result) {
        setPasteHint("no image on clipboard")
        return
      }
      insertAtCursor(` ${result.token} `)
      setPasteHint(null)
    } catch (err) {
      setPasteHint(`paste failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return { insertAtCursor, handlePaste, tryAttachClipboardImage }
}
