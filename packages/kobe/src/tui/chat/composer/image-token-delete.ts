import type { TextareaRenderable } from "@opentui/core"

/**
 * If the cursor is sitting immediately after a `[Image #N]` token,
 * delete the whole token in one keystroke. Otherwise return false so
 * the textarea's normal backspace behavior can run.
 */
export function deleteImageTokenBackward(ref: TextareaRenderable | undefined): boolean {
  if (!ref) return false
  if (ref.hasSelection()) return false
  const offset = ref.cursorOffset
  if (offset === 0) return false
  const match = /\[Image #(\d+)\]$/.exec(ref.plainText.slice(0, offset))
  if (!match) return false
  const start = offset - match[0].length
  ref.setSelection(start, offset)
  ref.deleteSelection()
  return true
}

/**
 * Forward-delete twin for `[Image #N]` placeholders starting at the
 * cursor. Mirrors {@link deleteImageTokenBackward} for the `delete` key.
 */
export function deleteImageTokenForward(ref: TextareaRenderable | undefined): boolean {
  if (!ref) return false
  if (ref.hasSelection()) return false
  const offset = ref.cursorOffset
  const text = ref.plainText
  if (offset >= text.length) return false
  const match = /^\[Image #(\d+)\]/.exec(text.slice(offset))
  if (!match) return false
  ref.setSelection(offset, offset + match[0].length)
  ref.deleteSelection()
  return true
}
