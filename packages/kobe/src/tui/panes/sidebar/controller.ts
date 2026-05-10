/**
 * Pure sidebar navigation controller.
 *
 * Lives in its own module (no Solid, no opentui) so unit tests can
 * exercise j/k/enter/g/G semantics without spinning up a renderer. The
 * Solid hook (`useSidebarBindings` in `keys.ts`) wires this controller's
 * methods into the keymap layer; the renderer-free split lets the
 * project's vitest worker (Node) load the controller while the renderer
 * itself only loads inside Bun.
 *
 * Cursor model:
 *   - The cursor indexes into `getFlatIds()` — the navigable task ids,
 *     headers excluded.
 *   - `setCursor(n)` is the only side effect on the cursor; the
 *     controller never reads or writes a Solid signal directly.
 *   - Range is `[0, ids.length-1]`; the controller clamps internally.
 *     `-1` is treated as "no selection yet" and behaves like 0 for
 *     movement.
 *
 * Chord:
 *   - `pressG` sets `pendingG` and schedules a timeout. A second
 *     `pressG` within the window completes the chord (jump to top) and
 *     disarms.
 *   - Any other navigation (j/k/enter/Shift+G) disarms the pending
 *     chord — vim semantics: "g d" doesn't do anything coherent so we
 *     drop it.
 *   - The timeout is injectable (`scheduleTimeout`) so tests run
 *     deterministically without real timers.
 */

/** How long after a `g` press a second `g` still completes the `g g` chord. */
export const GG_CHORD_TIMEOUT_MS = 700

/**
 * Inputs for the pure controller. Read-only accessors so the controller
 * doesn't bake in a particular reactivity flavor — Solid signals satisfy
 * `() => T` natively, but tests can pass plain getters too.
 */
export type SidebarControllerOpts = {
  /** Current cursor index into the flat task id list. -1 if no tasks. */
  getCursor: () => number
  /** Setter for the cursor index. The controller clamps to valid range. */
  setCursor: (next: number) => void
  /** Live flat list of navigable task ids, in display order. */
  getFlatIds: () => readonly string[]
  /** Selection callback. Fires on `selectCurrent` with the task id. */
  onSelect: (id: string) => void
  /**
   * Optional clock override for chord timing. Tests pass a fake to
   * deterministically expire the chord without a real timer. Defaults
   * to `setTimeout`. Returns a cancel function.
   */
  scheduleTimeout?: (cb: () => void, ms: number) => () => void
}

/**
 * The pure surface of the sidebar's key behavior. Each method is what
 * fires in response to a binding press; the j/k/enter/G/g handlers
 * delegate here.
 */
export type SidebarController = {
  moveDown(): void
  moveUp(): void
  selectCurrent(): void
  /**
   * Press `g`. Arms the `g g` chord; if already armed, completes it
   * (jump to top) and disarms.
   */
  pressG(): void
  /** Press `Shift+G` — jump to bottom. Always disarms any pending chord. */
  pressShiftG(): void
  /**
   * Used by tests to expose chord state. Not part of the production
   * API; renderer code never reads this.
   */
  isChordArmed(): boolean
  /**
   * Force-disarm any pending chord. Useful when other key handlers
   * upstream want to clear the state without making a navigation move.
   */
  disarmChord(): void
}

/**
 * Build a sidebar controller — pure, no Solid, no opentui. Side effects
 * happen only via the injected `setCursor` / `onSelect` callbacks and
 * the optional `scheduleTimeout`.
 */
export function createSidebarController(opts: SidebarControllerOpts): SidebarController {
  const schedule =
    opts.scheduleTimeout ??
    ((cb, ms) => {
      const t = setTimeout(cb, ms)
      return () => clearTimeout(t)
    })

  let pendingG = false
  let cancelTimer: (() => void) | null = null

  const armChord = () => {
    pendingG = true
    cancelTimer?.()
    cancelTimer = schedule(() => {
      pendingG = false
      cancelTimer = null
    }, GG_CHORD_TIMEOUT_MS)
  }
  const disarm = () => {
    pendingG = false
    cancelTimer?.()
    cancelTimer = null
  }

  const move = (delta: number) => {
    const ids = opts.getFlatIds()
    if (ids.length === 0) return
    const cur = opts.getCursor()
    const start = cur < 0 ? 0 : cur
    const next = Math.min(ids.length - 1, Math.max(0, start + delta))
    opts.setCursor(next)
  }
  const jumpTo = (index: number) => {
    const ids = opts.getFlatIds()
    if (ids.length === 0) return
    opts.setCursor(Math.min(ids.length - 1, Math.max(0, index)))
  }

  return {
    moveDown() {
      disarm()
      move(1)
    },
    moveUp() {
      disarm()
      move(-1)
    },
    selectCurrent() {
      disarm()
      const ids = opts.getFlatIds()
      const cur = opts.getCursor()
      if (cur < 0 || cur >= ids.length) return
      const id = ids[cur]
      if (id !== undefined) opts.onSelect(id)
    },
    pressG() {
      if (pendingG) {
        disarm()
        jumpTo(0)
      } else {
        armChord()
      }
    },
    pressShiftG() {
      disarm()
      jumpTo(opts.getFlatIds().length - 1)
    },
    isChordArmed() {
      return pendingG
    },
    disarmChord() {
      disarm()
    },
  }
}
