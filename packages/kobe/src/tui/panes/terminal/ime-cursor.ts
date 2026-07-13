import type { CursorPos } from "./pty-types"

/**
 * IME anchoring and cursor painting have different visibility semantics.
 * The painted cursor follows the PTY's current DECTCEM state; the IME anchor
 * retains the last visible position while an app briefly hides its cursor to
 * redraw. A new PTY identity starts with no inherited coordinate.
 */
export class ImeCursorRetention {
  private ptyIdentity: unknown = null
  private cursor: CursorPos | null = null

  update(ptyIdentity: unknown, cursor: CursorPos | null): CursorPos | null {
    if (ptyIdentity !== this.ptyIdentity) {
      this.ptyIdentity = ptyIdentity
      this.cursor = null
    }
    if (ptyIdentity === null) {
      this.cursor = null
      return null
    }
    if (cursor) this.cursor = { x: cursor.x, y: cursor.y }
    return this.cursor
  }

  current(): CursorPos | null {
    return this.cursor
  }
}
