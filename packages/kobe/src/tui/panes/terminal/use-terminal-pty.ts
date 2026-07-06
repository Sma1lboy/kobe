/**
 * PTY acquire/subscribe lifecycle for the embedded terminal pane —
 * extracted from `Terminal.tsx` (file-size cap) as the pane's "process"
 * half, leaving the component the render/geometry/input half. Same
 * contract as before the split:
 *
 *   - When `cwd`/`taskId` resolve (and the body has measured), acquire a
 *     `TaskPty` from the registry; `acquire` reuses a live PTY for the
 *     same key — the "kept alive while in_progress" rule.
 *   - On a key change we DON'T kill the old PTY (the orchestrator owns
 *     release); we just resubscribe to the new one's data.
 *   - On unmount we drop our subscription and reference only.
 *
 * The hook returns accessors for the current PTY + its latest snapshot,
 * cursor, exit flag and acquire error, plus `forceReacquire` — the
 * kill+fresh-acquire used by the F5 confirm and the external
 * `resetToken` bump (a caller whose command changed under the SAME pty
 * key: the shell-degrade flow).
 */

import { type Accessor, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js"
import type { CursorPos, TaskPty, TerminalRow } from "./pty"
import type { PtyRegistry } from "./registry"

export function useTerminalPty(opts: {
  cwd: Accessor<string | null>
  taskId: Accessor<string | null>
  /** Read at acquire time so a caller's prop swap stays reactive. */
  command: () => readonly string[] | undefined
  resetToken?: Accessor<number>
  onExit?: () => void
  registry: () => PtyRegistry
  bodyGeometry: Accessor<{ cols: number; rows: number } | null>
  /** Fires whenever a (re)acquire lands a fresh PTY — the pane resets its scrollback view. */
  onFreshPty: () => void
}): {
  pty: Accessor<TaskPty | null>
  snapshot: Accessor<readonly TerminalRow[]>
  cursor: Accessor<CursorPos | null>
  exited: Accessor<boolean>
  acquireError: Accessor<string | null>
  forceReacquire: (cwd: string, taskId: string, geometry: { cols: number; rows: number }) => void
} {
  // The current PTY — null when no task is active.
  const [pty, setPty] = createSignal<TaskPty | null>(null)

  // Surfaced when `registry.acquire()` throws. Without this, the effect's
  // exception bubbles out of the Solid scheduler and the pane renders
  // blank with no hint as to why.
  const [acquireError, setAcquireError] = createSignal<string | null>(null)

  // Latest structured snapshot from the PTY: one style-run list per row,
  // already opentui-ready. The Bun backend builds these straight from
  // xterm's cells; there is no ANSI string to re-parse.
  const [snapshot, setSnapshot] = createSignal<readonly TerminalRow[]>([])

  // Latest cursor position from the PTY (null when backend can't report).
  const [cursor, setCursor] = createSignal<CursorPos | null>(null)

  // Dead-shell flag (revival checklist #5): flips when the PTY reports
  // exit for any reason — its own end, a write failure, or an external
  // kill. The last snapshot stays visible (frozen output has value);
  // the banner + F5 reset are the recovery path.
  const [exited, setExited] = createSignal(false)

  const bodyGeometryReady = createMemo(() => opts.bodyGeometry() !== null)

  createEffect(
    on([opts.cwd, opts.taskId, bodyGeometryReady], ([cwd, taskId, geometryReady]) => {
      if (!cwd || !taskId || !geometryReady) {
        setPty(null)
        setSnapshot([])
        setCursor(null)
        setAcquireError(null)
        return
      }
      const geometry = opts.bodyGeometry()
      if (!geometry) return
      let handle: TaskPty
      try {
        handle = opts.registry().acquire(taskId, cwd, { ...geometry, command: opts.command() })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setAcquireError(message)
        setPty(null)
        setSnapshot([])
        setCursor(null)
        return
      }
      setAcquireError(null)
      setPty(handle)
      // Reset the caller's viewport on task switch — every task gets its own.
      opts.onFreshPty()
    }),
  )

  // Subscribe to whichever PTY is currently active. Own effect (keyed on
  // `pty()`) instead of inline with acquire so it reattaches whenever the
  // active PTY changes for any reason — task switch, reset, or recovery
  // after an external kill (wiring `onData` only in the acquire effect
  // left a `reset()`'s fresh PTY without a listener: input echoed to the
  // shell but never reached the snapshot signal).
  createEffect(() => {
    const handle = pty()
    const killed = handle ? handle.killed : false
    setExited(killed)
    if (!handle) return
    if (killed) {
      // Already dead by the time we mounted (e.g. re-selecting a
      // backgrounded ephemeral editor tab whose process quit while
      // unfocused) — fire onExit now, there's no live handle to attach
      // a listener to.
      opts.onExit?.()
      return
    }
    const unsubscribeExit = handle.onExit(() => {
      setExited(true)
      opts.onExit?.()
    })
    onCleanup(() => unsubscribeExit())
    const unsubscribe = handle.onData((snap, c) => {
      setSnapshot(snap)
      setCursor(c)
    })
    // Prime the renderer with whatever the backend has cached so a
    // freshly-mounted (or freshly-reset) pane doesn't blink empty
    // for one tick.
    try {
      const initial = handle.capture()
      if (initial.length > 0) setSnapshot(initial)
      setCursor(handle.captureCursor())
    } catch {
      /* capture can fail on a freshly-spawned shell; ignore */
    }
    onCleanup(() => {
      unsubscribe()
    })
  })

  // Final teardown: drop the registry reference. Don't kill the PTY —
  // the orchestrator owns kill via release().
  onCleanup(() => {
    setPty(null)
  })

  // Kill + fresh-acquire under the same `cwd`/`taskId` (shared by the F5
  // confirm and the external `resetToken` bump) — reset the render
  // signals together so a stale snapshot/cursor never survives onto the
  // new PTY.
  const forceReacquire = (cwd: string, taskId: string, geometry: { cols: number; rows: number }): void => {
    try {
      const fresh = opts.registry().reset(taskId, cwd, { ...geometry, command: opts.command() })
      setPty(fresh)
      setSnapshot([])
      setCursor(null)
      opts.onFreshPty()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      setAcquireError(message)
    }
  }

  // External forced-reacquire (see `resetToken` on TerminalProps) —
  // skipped on the initial mount (`defer: true`) so a fresh pane doesn't
  // reset itself the instant it acquires its first PTY.
  createEffect(
    on(
      () => opts.resetToken?.(),
      () => {
        const cwd = opts.cwd()
        const taskId = opts.taskId()
        const geometry = opts.bodyGeometry()
        if (cwd && taskId && geometry) forceReacquire(cwd, taskId, geometry)
      },
      { defer: true },
    ),
  )

  return { pty, snapshot, cursor, exited, acquireError, forceReacquire }
}
