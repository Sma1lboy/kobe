/**
 * PTY acquire/subscribe lifecycle for the embedded terminal pane — React
 * port of `tui/panes/terminal/use-terminal-pty.ts` (issue #16 React
 * migration). Same contract as the Solid original:
 *
 *   - When `cwd`/`taskId` resolve (and the body has measured), acquire a
 *     `TaskPty` from the registry; `acquire` reuses a live PTY for the
 *     same key — the "kept alive while in_progress" rule.
 *   - On a key change we DON'T kill the old PTY (the orchestrator owns
 *     release); we just resubscribe to the new one's data.
 *   - On unmount we drop our subscription and reference only.
 *
 * Solid→React prop delta: `cwd`/`taskId`/`command`/`resetToken`/
 * `bodyGeometry` are plain values here (React re-renders on prop change),
 * not Accessors. The Solid acquire effect deliberately tracks ONLY
 * `[cwd, taskId, bodyGeometryReady]` — `command` and the live geometry
 * value are read untracked at acquire time so a caller's prop swap alone
 * doesn't force a re-acquire (that's what `resetToken` is for). We
 * reproduce that by keeping `command`/`bodyGeometry` in refs and using
 * `[cwd, taskId, geometryReady]` as the effect's dependency array.
 */

import { errorMessage } from "@/lib/error-message"
import { useCallback, useEffect, useRef, useState } from "react"
import type { CursorPos, TaskPty, TerminalRow } from "../../../tui/panes/terminal/pty"
import type { PtyRegistry } from "../../../tui/panes/terminal/registry"
import { useLatest } from "../../lib/use-latest"

export interface UseTerminalPtyOpts {
  cwd: string | null
  taskId: string | null
  /** Read at acquire/reset time via a ref — see file header. */
  command: readonly string[] | undefined
  resetToken?: number
  /** `deadOnAttach`: the exit was discovered on reattach (engine died
   *  while the TUI was away), not observed live — see `TaskPtyLike`. */
  onExit?: (info?: { deadOnAttach?: boolean }) => void
  registry: PtyRegistry
  bodyGeometry: { cols: number; rows: number } | null
  /** Fires whenever a (re)acquire lands a fresh PTY — the pane resets its scrollback view. */
  onFreshPty: () => void
}

export interface UseTerminalPtyResult {
  pty: TaskPty | null
  snapshot: readonly TerminalRow[]
  cursor: CursorPos | null
  exited: boolean
  acquireError: string | null
  forceReacquire: (cwd: string, taskId: string, geometry: { cols: number; rows: number }) => void
}

export function useTerminalPty(opts: UseTerminalPtyOpts): UseTerminalPtyResult {
  const [pty, setPty] = useState<TaskPty | null>(null)
  // Surfaced when `registry.acquire()` throws — without this the pane
  // would render blank with no hint as to why.
  const [acquireError, setAcquireError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<readonly TerminalRow[]>([])
  const [cursor, setCursor] = useState<CursorPos | null>(null)
  // Dead-shell flag (revival checklist #5): flips when the PTY reports
  // exit for any reason. The last snapshot stays visible; the banner +
  // F5 reset are the recovery path.
  const [exited, setExited] = useState(false)

  // Latest-render mirrors read by effect bodies that must NOT depend on
  // them (the Solid original's untracked reads inside `on(...)`).
  const commandRef = useLatest(opts.command)
  const bodyGeometryRef = useLatest(opts.bodyGeometry)
  const registryRef = useLatest(opts.registry)
  const onExitRef = useLatest(opts.onExit)
  const onFreshPtyRef = useLatest(opts.onFreshPty)
  // Read untracked by the resetToken effect below (see file header); the
  // acquire effect intentionally reads the plain `cwd`/`taskId` values
  // instead, since THAT effect is meant to depend on them.
  const cwdRef = useLatest(opts.cwd)
  const taskIdRef = useLatest(opts.taskId)

  const geometryReady = opts.bodyGeometry !== null
  const cwd = opts.cwd
  const taskId = opts.taskId

  useEffect(() => {
    if (!cwd || !taskId || !geometryReady) {
      setPty(null)
      setSnapshot([])
      setCursor(null)
      setAcquireError(null)
      return
    }
    const geometry = bodyGeometryRef.current
    if (!geometry) return
    let handle: TaskPty
    try {
      handle = registryRef.current.acquire(taskId, cwd, { ...geometry, command: commandRef.current })
    } catch (err) {
      const message = errorMessage(err)
      setAcquireError(message)
      setPty(null)
      setSnapshot([])
      setCursor(null)
      return
    }
    setAcquireError(null)
    setPty(handle)
    // Reset the caller's viewport on task switch — every task gets its own.
    onFreshPtyRef.current()
  }, [cwd, taskId, geometryReady])

  // Subscribe to whichever PTY is currently active. Own effect (keyed on
  // `pty`) instead of folded into the acquire effect so it reattaches
  // whenever the active PTY changes for any reason — task switch, reset,
  // or recovery after an external kill.
  useEffect(() => {
    const killed = pty ? pty.killed : false
    setExited(killed)
    if (!pty) return
    if (killed) {
      // Already dead by the time we mounted — fire onExit now, there's no
      // live handle to attach a listener to.
      onExitRef.current?.({ deadOnAttach: pty.deadOnAttach === true })
      return
    }
    const unsubscribeExit = pty.onExit(() => {
      setExited(true)
      onExitRef.current?.({ deadOnAttach: pty.deadOnAttach === true })
    })
    const unsubscribe = pty.onData((snap, c) => {
      setSnapshot(snap)
      setCursor(c)
    })
    // Prime the renderer with whatever the backend has cached so a
    // freshly-mounted (or freshly-reset) pane doesn't blink empty for one
    // tick.
    try {
      const initial = pty.capture()
      if (initial.length > 0) setSnapshot(initial)
      setCursor(pty.captureCursor())
    } catch {
      /* capture can fail on a freshly-spawned shell; ignore */
    }
    return () => {
      unsubscribeExit()
      unsubscribe()
    }
  }, [pty])

  // Kill + fresh-acquire under the same `cwd`/`taskId` (shared by the F5
  // confirm and the external `resetToken` bump) — reset the render
  // signals together so a stale snapshot/cursor never survives onto the
  // new PTY.
  const forceReacquire = useCallback(
    (nextCwd: string, nextTaskId: string, geometry: { cols: number; rows: number }): void => {
      try {
        const fresh = registryRef.current.reset(nextTaskId, nextCwd, { ...geometry, command: commandRef.current })
        setPty(fresh)
        setSnapshot([])
        setCursor(null)
        onFreshPtyRef.current()
      } catch (err) {
        const message = errorMessage(err)
        // `registry.reset()` kills the old PTY BEFORE the acquire half runs,
        // so on failure there is no live handle left — clear the pane to the
        // error state (same shape as the acquire effect's failure path)
        // instead of leaving a dead snapshot up with the error invisible.
        setAcquireError(message)
        setPty(null)
        setSnapshot([])
        setCursor(null)
      }
    },
    [],
  )

  // External forced-reacquire (see `resetToken` on TerminalProps) —
  // skipped on the initial mount (Solid's `defer: true`) so a fresh pane
  // doesn't reset itself the instant it acquires its first PTY.
  const resetMountedRef = useRef(false)
  useEffect(() => {
    // Dependency-only invalidation key — this effect fires ONLY when
    // resetToken bumps, it doesn't read the value itself.
    void opts.resetToken
    if (!resetMountedRef.current) {
      resetMountedRef.current = true
      return
    }
    const nextCwd = cwdRef.current
    const nextTaskId = taskIdRef.current
    const geometry = bodyGeometryRef.current
    if (nextCwd && nextTaskId && geometry) forceReacquire(nextCwd, nextTaskId, geometry)
    // `forceReacquire` is stable (empty-dep useCallback below) — listing it
    // satisfies the linter without changing when this effect re-fires.
  }, [opts.resetToken, forceReacquire])

  return { pty, snapshot, cursor, exited, acquireError, forceReacquire }
}
