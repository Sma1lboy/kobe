import type { CursorPos } from "./pty-types"

class PtyCoordinateRetention {
  private ptyIdentity: unknown = null
  private coordinate: CursorPos | null = null

  update(ptyIdentity: unknown, coordinate: CursorPos | null): CursorPos | null {
    if (ptyIdentity !== this.ptyIdentity) {
      this.ptyIdentity = ptyIdentity
      this.coordinate = null
    }
    if (ptyIdentity === null) {
      this.coordinate = null
      return null
    }
    if (coordinate) this.coordinate = { x: coordinate.x, y: coordinate.y }
    return this.coordinate
  }

  current(): CursorPos | null {
    return this.coordinate
  }
}

/**
 * IME anchoring and cursor painting have different visibility semantics.
 * The painted cursor follows the PTY's current DECTCEM state; the IME anchor
 * retains the last visible position while an app briefly hides its cursor to
 * redraw. A new PTY identity starts with no inherited coordinate.
 */
export class ImeCursorRetention extends PtyCoordinateRetention {}

export type ImeScreenAnchor = CursorPos

/** Retain layout gaps for one PTY without leaking coordinates to the next. */
export class ImeScreenAnchorRetention extends PtyCoordinateRetention {}
