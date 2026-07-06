import { useRenderer } from "@opentui/solid"
import { type Accessor, type JSXElement, createContext, createSignal, useContext } from "solid-js"

export type PaneId = "sidebar" | "workspace" | "files" | "terminal"

export const PANE_ORDER = ["sidebar", "workspace", "files", "terminal"] as const satisfies readonly PaneId[]

export type FocusContextValue = {
  focused: Accessor<PaneId>
  is: (pane: PaneId) => Accessor<boolean>
  setFocused: (pane: PaneId) => void
  cycle: (delta: 1 | -1) => void
  refocusTick: Accessor<number>
}

const FocusContext = createContext<FocusContextValue | null>(null)

export function FocusProvider(props: { children: JSXElement; initial?: PaneId }): JSXElement {
  const [focused, setFocusedSignal] = createSignal<PaneId>(props.initial ?? "sidebar")
  const [refocusTick, setRefocusTick] = createSignal(0)
  const renderer = useRenderer()

  function setFocused(pane: PaneId): void {
    setRefocusTick((t) => t + 1)
    if (focused() === pane) return
    const current = renderer?.currentFocusedRenderable
    if (current && !current.isDestroyed) {
      try {
        current.blur()
      } catch {}
    }
    setFocusedSignal(pane)
  }

  function cycle(delta: 1 | -1): void {
    const idx = PANE_ORDER.indexOf(focused())
    const next = (idx + delta + PANE_ORDER.length) % PANE_ORDER.length
    setFocused(PANE_ORDER[next] as PaneId)
  }

  const accessorCache = new Map<PaneId, Accessor<boolean>>()
  function is(pane: PaneId): Accessor<boolean> {
    let acc = accessorCache.get(pane)
    if (!acc) {
      acc = () => focused() === pane
      accessorCache.set(pane, acc)
    }
    return acc
  }

  const value: FocusContextValue = { focused, is, setFocused, cycle, refocusTick }
  return <FocusContext.Provider value={value}>{props.children}</FocusContext.Provider>
}

export function useFocus(): FocusContextValue {
  const ctx = useContext(FocusContext)
  if (!ctx) {
    throw new Error("useFocus: must be called inside <FocusProvider>. See src/tui/context/focus.tsx.")
  }
  return ctx
}
