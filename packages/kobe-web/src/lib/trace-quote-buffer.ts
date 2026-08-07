export type BufferedSubmitKey = Readonly<{
  key: string
  shiftKey?: boolean
  altKey?: boolean
  ctrlKey?: boolean
  metaKey?: boolean
  isComposing?: boolean
}>

/** Only plain Enter submits buffered context. Native multiline and IME input
 * must continue to follow the engine's own keyboard grammar. */
export function isBufferedSubmitKey(event: BufferedSubmitKey): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.isComposing
  )
}
