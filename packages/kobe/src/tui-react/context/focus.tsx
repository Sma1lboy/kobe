/** @jsxImportSource @opentui/react */
/**
 * Pane focus — global, single source of truth (React port of
 * `src/tui/context/focus.tsx`, issue #15 G2). Same responsibilities: pane
 * wrappers set focus on click, panes gate their keybindings on it, global
 * single-letter shortcuts gate on the workspace NOT being focused.
 *
 * API deltas from the Solid version, by design:
 *   - `focused` is a plain value (was `Accessor<PaneId>`).
 *   - `is(pane)` returns a boolean (was a memoized `Accessor<boolean>`);
 *     Solid call sites `is("sidebar")()` become `is("sidebar")`.
 *   - `refocusTick` is a plain number that increments on every `setFocused`
 *     call — even same-pane — so input-bearing children can re-assert
 *     native focus in an effect keyed on it (same one-tick-race fix).
 */

import { useRenderer } from "@opentui/react"
import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from "react"

/** The four primary panes in kobe's layout. */
export type PaneId = "sidebar" | "workspace" | "files" | "terminal"

/** Cycle order — used by `tab` / `shift+tab`. */
export const PANE_ORDER = ["sidebar", "workspace", "files", "terminal"] as const satisfies readonly PaneId[]

export type FocusContextValue = {
  /** The currently focused pane. */
  focused: PaneId
  /** True when `pane` is the focused one. */
  is: (pane: PaneId) => boolean
  /** Set the focused pane. */
  setFocused: (pane: PaneId) => void
  /** Cycle by ±1 through PANE_ORDER. Used by `tab` / `shift+tab`. */
  cycle: (delta: 1 | -1) => void
  /** Increments on every `setFocused` call — even same-pane (see header). */
  refocusTick: number
}

const FocusContext = createContext<FocusContextValue | null>(null)

/**
 * Mount the focus state at the top of the tree. Default focused pane is
 * `sidebar`: on cold boot there's no task selected, so the sidebar's task
 * list is the natural starting point and single-letter global shortcuts
 * work because the composer isn't claiming keys.
 */
export function FocusProvider(props: { children?: ReactNode; initial?: PaneId }) {
  const [focused, setFocusedState] = useState<PaneId>(props.initial ?? "sidebar")
  const [refocusTick, setRefocusTick] = useState(0)
  const renderer = useRenderer()
  // Latest focused value for the stable callbacks below (React state reads
  // in callbacks go stale; the ref always holds the current pane).
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  /**
   * Unified focus-change entry point (same contract as the Solid provider):
   * tick refocus unconditionally, then on a real transition blur whatever
   * opentui renderable holds native focus BEFORE flipping the pane state —
   * removing the one-tick window where a composer textarea keeps eating
   * keystrokes after the user chorded away from the workspace.
   */
  const setFocused = useCallback(
    (pane: PaneId): void => {
      setRefocusTick((t) => t + 1)
      if (focusedRef.current === pane) return
      const current = renderer?.currentFocusedRenderable
      if (current && !current.isDestroyed) {
        try {
          current.blur()
        } catch {
          // best-effort; if blur throws (renderable in a bad state)
          // we still want the pane focus state to flip.
        }
      }
      setFocusedState(pane)
    },
    [renderer],
  )

  const cycle = useCallback(
    (delta: 1 | -1): void => {
      const idx = PANE_ORDER.indexOf(focusedRef.current)
      const next = (idx + delta + PANE_ORDER.length) % PANE_ORDER.length
      setFocused(PANE_ORDER[next] as PaneId)
    },
    [setFocused],
  )

  const value = useMemo<FocusContextValue>(
    () => ({
      focused,
      is: (pane: PaneId) => focused === pane,
      setFocused,
      cycle,
      refocusTick,
    }),
    [focused, refocusTick, setFocused, cycle],
  )

  return <FocusContext.Provider value={value}>{props.children}</FocusContext.Provider>
}

/**
 * Read the focus context. Throws if called outside `<FocusProvider>` —
 * that's almost always a bug, so we fail loud rather than fall back to
 * a no-op default.
 */
export function useFocus(): FocusContextValue {
  const ctx = useContext(FocusContext)
  if (!ctx) {
    throw new Error("useFocus: must be called inside <FocusProvider>. See src/tui-react/context/focus.tsx.")
  }
  return ctx
}
