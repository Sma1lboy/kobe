/** @jsxImportSource @opentui/react */

import { useRenderer } from "@opentui/react"
import { type ReactNode, createContext, useCallback, useContext, useMemo, useRef, useState } from "react"

export type PaneId = "sidebar" | "workspace" | "files" | "terminal"

export const PANE_ORDER = ["sidebar", "workspace", "files", "terminal"] as const satisfies readonly PaneId[]

export type FocusContextValue = {
  focused: PaneId
  is: (pane: PaneId) => boolean
  setFocused: (pane: PaneId) => void
  cycle: (delta: 1 | -1) => void
  refocusTick: number
}

const FocusContext = createContext<FocusContextValue | null>(null)

export function FocusProvider(props: { children?: ReactNode; initial?: PaneId }) {
  const [focused, setFocusedState] = useState<PaneId>(props.initial ?? "sidebar")
  const [refocusTick, setRefocusTick] = useState(0)
  const renderer = useRenderer()
  const focusedRef = useRef(focused)
  focusedRef.current = focused

  const setFocused = useCallback(
    (pane: PaneId): void => {
      setRefocusTick((t) => t + 1)
      if (focusedRef.current === pane) return
      const current = renderer?.currentFocusedRenderable
      if (current && !current.isDestroyed) {
        try {
          current.blur()
        } catch {}
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

export function useFocus(): FocusContextValue {
  const ctx = useContext(FocusContext)
  if (!ctx) {
    throw new Error("useFocus: must be called inside <FocusProvider>. See src/tui-react/context/focus.tsx.")
  }
  return ctx
}
