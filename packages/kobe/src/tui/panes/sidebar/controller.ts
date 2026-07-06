export const GG_CHORD_TIMEOUT_MS = 700

export type SidebarControllerOpts = {
  getCursor: () => number
  setCursor: (next: number) => void
  getFlatIds: () => readonly string[]
  onSelect: (id: string) => void
  scheduleTimeout?: (cb: () => void, ms: number) => () => void
}

export type SidebarController = {
  moveDown(): void
  moveUp(): void
  selectCurrent(): void
  pressG(): void
  pressShiftG(): void
  isChordArmed(): boolean
  disarmChord(): void
}

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
