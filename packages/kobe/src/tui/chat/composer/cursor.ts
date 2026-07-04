import type { TextareaRenderable } from "@opentui/core"

/**
 * True if the caret is on the buffer's first logical line. Wrapped
 * terminal lines do not count; history navigation follows buffer lines.
 */
export function isCursorAtFirstLine(ref: TextareaRenderable | undefined): boolean {
  if (!ref) return true
  const offset = ref.cursorOffset
  const text = ref.plainText
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") return false
  }
  return true
}

/**
 * True if the caret is on the buffer's last logical line. Wrapped
 * terminal lines do not count; history navigation follows buffer lines.
 */
export function isCursorAtLastLine(ref: TextareaRenderable | undefined): boolean {
  if (!ref) return true
  const offset = ref.cursorOffset
  const text = ref.plainText
  for (let i = offset; i < text.length; i++) {
    if (text[i] === "\n") return false
  }
  return true
}
